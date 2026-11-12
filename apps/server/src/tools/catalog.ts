import { type RegistryToolset, ToolError, defineTool } from '@holtkeeper/agent-tools'
import type { PublicApiPackageRemoval, RepoRef } from '@holtkeeper/api'
import {
  type ApiPackage,
  type PackageDiff,
  apiSymbolKinds,
  diffPackage,
  importPath,
  renderDiff,
  renderPackage,
  renderSymbol,
} from '@holtkeeper/api-surface'
import { type LatestVersions, sameVersion, thirdParty } from '@holtkeeper/libraries'
import type { LibraryEcosystem, LibraryRef, Store } from '@holtkeeper/store'
import {
  findSites,
  packageUsage,
  renderImpact,
  renderPackageUsage,
  renderSites,
  repoPackages,
  usageKinds,
} from '@holtkeeper/usages'
import { z } from 'zod'

import type { ApiCatalog, RepoFilter } from '../api-surface/catalog.ts'
import { type UsageIndex, impactOf, impactOfChanges } from '../api-surface/usages.ts'
import { repoKey } from '../context.ts'
import { evaluateDependency } from './dependency.ts'
import type { KnowledgeToolsContext } from './knowledge.ts'
import { type LibraryIndex, ecosystemArg } from './libraries.ts'
import { type SupplyToolsAccess, readableRepo, supplyTools } from './repos.ts'
import type { StackToolsContext } from './stack.ts'
import { whoUses } from './who-uses.ts'

/** What the `catalog` tools read, limited to what one caller may see. */
export interface CatalogToolsContext {
  catalog: ApiCatalog
  usages: UsageIndex
  /** Stored analyses and audits that `evaluate_dependency` reads. */
  store: Pick<Store, 'analyses' | 'auditRuns'>
  /** The knowledge base `evaluate_dependency` quotes. */
  knowledge: KnowledgeToolsContext
  /** Repositories whose API, usages and stored analyses the caller may read (catalog reach). */
  canRead: RepoFilter
  /** Repositories whose usage snippets the caller may read; default `canRead`. */
  canReadSnippets?: RepoFilter
  /** Repositories whose analyzer results (licenses, bundles, Renovate) the caller may read. */
  canReadAnalyses: RepoFilter
  /** Repositories whose audits the caller may read. */
  canReadAudits: RepoFilter
  /** Repositories whose audit `repo.analyzers` turns off; `evaluate_dependency` leaves them out. */
  auditOff?: () => Promise<RepoFilter>
  /** The teams of a repository (innermost config groups), named on results; without it no team is named. */
  ownerOf?: (repo: RepoRef) => string[]
  /** Latest registry versions, for how far behind a repository is. */
  latest?: Pick<LatestVersions, 'all'>
  /** Stack records; with it the `stack` toolset is offered and `who_uses` covers stack tools. */
  stack?: StackToolsContext
  /** The third-party library index; without it only the organization's own packages are covered. */
  library?: Pick<LibraryIndex, 'api' | 'store'>
  /** The asker's findings and licenses; with it `security_findings` and `license_overview` are offered. */
  supply?: SupplyToolsAccess
}

const repoOfKey = (key: string): RepoRef => {
  const separator = key.indexOf(':')
  return { forge: key.slice(0, separator), path: key.slice(separator + 1) }
}

const removalNote = (name: string, repo: RepoRef, removed: PublicApiPackageRemoval) =>
  [
    `**Removed:** \`${repoKey(repo)}\` dropped ${name} on ${removed.at.slice(0, 10)}; do not use it in new code and plan to migrate existing uses.`,
    ...(removed.renamedTo ? [`It was probably renamed to ${removed.renamedTo}.`] : []),
    ...(removed.movedTo
      ? [
          `It still lives in ${removed.movedTo.map((r) => `\`${repoKey(r)}\``).join(', ')} (pass \`repo\`).`,
        ]
      : []),
  ].join(' ')

const refOf = (name: string, ecosystem: LibraryEcosystem | undefined): LibraryRef => ({
  ecosystem: ecosystem ?? 'npm',
  name,
})

const renderExternal = (
  ref: LibraryRef,
  version: string,
  packages: ApiPackage[],
  options: { subpath?: string; docs?: boolean },
) =>
  thirdParty(
    `${ref.name}@${version} (${ref.ecosystem}, API from the published package)`,
    packages
      .map((pkg) =>
        renderPackage(pkg, {
          ref: version,
          ...(options.subpath ? { subpath: options.subpath } : {}),
          ...(options.docs === false ? { docs: false } : {}),
        }),
      )
      .join('\n\n'),
  )

/**
 * The `catalog` toolset over the organization's packages and how repositories use them, with
 * third-party fallbacks from the library index: `list_packages`, `get_package_api`,
 * `search_symbols`, `get_symbol`, `list_versions`, `diff_versions`, `package_usage`,
 * `find_usages`, `upgrade_impact`, `repo_packages`, `evaluate_dependency` and `who_uses`, plus
 * `security_findings` and `license_overview` with `supply`. Every result is limited to the
 * repositories `canRead` allows; findings and licenses to what `supply` answers the asker.
 */
export function catalogToolset(context: CatalogToolsContext): RegistryToolset {
  const { catalog, usages, canRead, library } = context
  const canReadSnippets = context.canReadSnippets ?? canRead
  const teamOf = (origin: string) => {
    const owner = context.ownerOf?.(repoOfKey(origin))
    return owner?.length ? owner.join(', ') : undefined
  }

  const notFound = async (name: string, version?: string) => {
    const known = await catalog.packages(canRead)
    if (known.some((pkg) => pkg.name === name) && version)
      return new ToolError(
        `${name} has no version ${version}; call list_versions for the recorded ones.`,
      )
    const owner = known
      .filter((pkg) => name.startsWith(`${pkg.name}/`))
      .toSorted((a, b) => b.name.length - a.name.length)[0]
    if (owner)
      return new ToolError(
        `${name} is a deep import into ${owner.name}; entry points: ${owner.subpaths.map((s) => importPath(owner.name, s)).join(', ')}. Call get_package_api ${owner.name} (narrow with subpath) or search_symbols by export name.`,
      )
    const close = known
      .filter(
        (pkg) => pkg.name.includes(name) || name.includes(pkg.name.split('/').pop() ?? '\u0000'),
      )
      .map((pkg) => pkg.name)
      .slice(0, 10)
    return new ToolError(
      `No package ${name} in the catalog.${close.length ? ` Similar: ${close.join(', ')}.` : ' Call list_packages to see what is indexed.'}`,
    )
  }

  const externalVersion = async (
    ref: LibraryRef,
    requested: string | undefined,
    repo: string | undefined,
  ) => {
    if (!library) return undefined
    const withApi = await library.api.versions(ref)
    if (!withApi.length) return undefined
    const records = (await library.store.listVersions(ref)).filter((record) =>
      withApi.includes(record.version),
    )
    const wanted = requested?.trim()
    if (wanted && wanted !== 'latest' && wanted !== 'head') {
      const found = withApi.find((version) => sameVersion(version, wanted))
      if (!found)
        throw new ToolError(
          `${ref.name}@${wanted} has no indexed API; indexed: ${withApi.join(', ')}. Call library_versions for the matrix.`,
        )
      return { version: found, versions: withApi, records }
    }
    const readable = readableRepo(canRead, repo)
    const used =
      wanted || !readable
        ? undefined
        : records.find((record) => record.usedBy.includes(readable))?.version
    const latest = records.find((record) => record.roles.includes('latest'))?.version
    return { version: used ?? latest ?? withApi[0] ?? '', versions: withApi, records }
  }

  const externalApi = async (ref: LibraryRef, version: string) => {
    const packages = await library?.api.get(ref, version)
    if (!packages?.length)
      throw new ToolError(`The API of ${ref.name}@${version} could not be read.`)
    return packages
  }

  const externalDiff = async (
    ref: LibraryRef,
    query: { from?: string; to?: string; repo?: string },
  ) => {
    const to = await externalVersion(ref, query.to, query.repo)
    if (!to) return undefined
    const index = to.versions.indexOf(to.version)
    const fromVersion = query.from
      ? (await externalVersion(ref, query.from, undefined))?.version
      : to.versions[index + 1]
    if (!fromVersion)
      throw new ToolError(
        `${ref.name} has no indexed API below ${to.version}; indexed: ${to.versions.join(', ')}.`,
      )
    const [before, after] = await Promise.all([
      externalApi(ref, fromVersion),
      externalApi(ref, to.version),
    ])
    const names = [...new Set([...before, ...after].map((pkg) => pkg.name))].toSorted()
    const diffs: PackageDiff[] = names.map((pkgName) =>
      diffPackage(
        before.find((pkg) => pkg.name === pkgName),
        after.find((pkg) => pkg.name === pkgName),
      ),
    )
    return { from: fromVersion, to: to.version, before, diffs }
  }

  const versionArg = z
    .string()
    .optional()
    .describe(
      'Version such as 1.4.0, a tag, `latest` (newest release, default) or `head` (default branch)',
    )
  const repoArg = z
    .string()
    .optional()
    .describe(
      'Repository as forge:path when several repositories have a package of that name; for third-party packages, the repository whose version is the default',
    )

  return {
    name: 'catalog',
    instructions: [
      'Holtkeeper indexes the public API of the packages in this organization’s repositories: every',
      'exported name with its declaration and doc comment, for each released version and the default',
      'branch. Prefer it over reading package sources or node_modules.',
      'Start with search_symbols or list_packages, read get_package_api (narrow with subpath or',
      'docs: false for big packages), and use list_versions / diff_versions to see what changed',
      'between versions before upgrading. Packages marked removed were dropped from their repository:',
      'do not add new uses of them.',
      'It also indexes how every repository uses its dependencies: package_usage shows who uses a',
      'package, at which versions and which exports, members and JSX props; find_usages returns the',
      'code of those uses; upgrade_impact lists the uses an upgrade breaks, for planning migrations;',
      'repo_packages lists what one repository depends on; who_uses answers which teams and',
      'repositories use a library, internal package or stack tool at which versions.',
      'Before adding or upgrading a dependency, call evaluate_dependency: who already uses it,',
      'advisories, licenses, bundle share and team decisions about it.',
      ...(context.supply
        ? [
            'security_findings lists open, fixing and allowlisted vulnerability findings across',
            'repositories; license_overview shows license compliance and the license policy.',
          ]
        : []),
    ].join(' '),
    tools: [
      defineTool({
        name: 'list_packages',
        description:
          'Lists the indexed packages (newest version of each) with their repository, description, entry points and how many versions are recorded. Filter with a substring of the name, description or repository.',
        input: z.object({
          query: z
            .string()
            .optional()
            .describe('Substring of a package name, description or repository'),
        }),
        run: async ({ query }) => {
          const packages = await catalog.packages(canRead, query)
          if (!packages.length)
            return query ? `No package matches "${query}".` : 'No package is indexed yet.'
          const line = (pkg: (typeof packages)[number]) =>
            `- **${pkg.name}**${pkg.version ? `@${pkg.version}` : ''}${pkg.private ? ' (private)' : ''}${pkg.description ? ` — ${pkg.description}` : ''}\n  repo \`${repoKey(pkg.repo)}\`${pkg.dir !== '.' ? ` folder \`${pkg.dir}\`` : ''}, ${pkg.exports} exports, entry points ${pkg.subpaths.map((s) => `\`${importPath(pkg.name, s)}\``).join(', ')}, ${pkg.versions} version${pkg.versions === 1 ? '' : 's'} recorded${pkg.removed ? `\n  ${removalNote(pkg.name, pkg.repo, pkg.removed)}` : ''}`
          const removed = packages.filter((pkg) => pkg.removed)
          return [
            ...packages.filter((pkg) => !pkg.removed).map(line),
            ...(removed.length
              ? [
                  '',
                  'Removed from their repositories, do not use in new code:',
                  ...removed.map(line),
                ]
              : []),
          ].join('\n')
        },
        subject: ({ query }) => query,
      }),

      defineTool({
        name: 'get_package_api',
        description:
          'The public API of one package version as Markdown: each entry point (import path) with every exported name, its doc comment and declaration. For large packages pass `subpath` or `docs: false`.',
        input: z.object({
          package: z.string().describe('Package name, e.g. @acme/ui'),
          version: versionArg,
          subpath: z.string().optional().describe('Entry point such as `.` or `./button`'),
          docs: z.boolean().optional().describe('Include doc comments (default true)'),
          repo: repoArg,
          ecosystem: ecosystemArg,
        }),
        run: async ({ package: name, version, subpath, docs, repo, ecosystem }) => {
          const found =
            ecosystem === 'Go'
              ? undefined
              : await catalog.resolve(canRead, name, {
                  ...(version ? { version } : {}),
                  ...(repo ? { repo } : {}),
                })
          if (!found) {
            const ref = refOf(name, ecosystem)
            const external = await externalVersion(ref, version, repo)
            if (!external) throw await notFound(name, version)
            const packages = (await externalApi(ref, external.version)).filter(
              (pkg) => !subpath || pkg.entries.some((entry) => entry.subpath === subpath),
            )
            if (!packages.length)
              throw new ToolError(`${name}@${external.version} has no entry point ${subpath}.`)
            const others = external.versions.filter((v) => v !== external.version).slice(0, 8)
            return [
              renderExternal(ref, external.version, packages, {
                ...(subpath ? { subpath } : {}),
                ...(docs === false ? { docs: false } : {}),
              }),
              ...(others.length ? [`Other indexed versions: ${others.join(', ')}.`] : []),
            ].join('\n\n')
          }
          if (subpath && !found.package.entries.some((entry) => entry.subpath === subpath))
            throw new ToolError(
              `${name} has no entry point ${subpath}; it has ${found.package.entries.map((entry) => entry.subpath).join(', ')}.`,
            )
          const others = found.versions
            .filter((v) => v.analysisId !== found.version.analysisId)
            .slice(0, 8)
            .map((v) => (v.head ? 'head' : v.version))
          return [
            ...(found.removed ? [removalNote(name, found.record.repo, found.removed)] : []),
            renderPackage(found.package, {
              repo: repoKey(found.record.repo),
              ...(found.record.ref ? { ref: found.record.ref } : {}),
              analyzedAt: found.record.createdAt,
              ...(subpath ? { subpath } : {}),
              ...(docs === false ? { docs: false } : {}),
            }),
            ...(others.length ? [`Other recorded versions: ${others.join(', ')}.`] : []),
          ].join('\n\n')
        },
        subject: ({ package: name }) => name,
      }),

      defineTool({
        name: 'search_symbols',
        description:
          'Finds exported functions, classes, types and constants by name (exact, prefix, substring) or doc comment text across the newest version of every package. Returns import paths, declarations and the first line of docs.',
        input: z.object({
          query: z.string().min(1).describe('Name or words to look for'),
          package: z.string().optional().describe('Only this package'),
          kind: z.enum(apiSymbolKinds).optional().describe('Only this kind of export'),
          limit: z.number().int().min(1).max(50).optional().describe('Default 20'),
        }),
        defaultLimit: 20,
        run: async ({ query, package: name, kind, limit }) => {
          const result = await catalog.search(canRead, query, {
            ...(name ? { package: name } : {}),
            ...(kind ? { kind } : {}),
            limit: limit ?? 20,
          })
          if (!result.hits.length) return `Nothing exported matches "${query}".`
          const lines = result.hits.map((hit) => {
            const doc = hit.symbol.doc?.split('\n\n')[0]
            const signature =
              hit.symbol.signature.length > 600
                ? `${hit.symbol.signature.slice(0, 600)}\n…`
                : hit.symbol.signature
            return [
              `### \`${hit.importPath}\` → ${hit.symbol.name} (${hit.symbol.kind})`,
              `${hit.package}${hit.version ? `@${hit.version}` : ''}, repo \`${repoKey(hit.repo)}\`${hit.symbol.deprecated !== undefined ? ', **deprecated**' : ''}`,
              ...(doc ? [doc] : []),
              `\`\`\`ts\n${signature}\n\`\`\``,
            ].join('\n\n')
          })
          if (result.more)
            lines.push(`…and ${result.more} more matches; narrow with \`package\` or \`kind\`.`)
          return lines.join('\n\n')
        },
        subject: ({ package: name, query }) => name ?? query,
      }),

      defineTool({
        name: 'get_symbol',
        description:
          'One exported name of a package in full: doc comment, declaration, source location and the import statement to use.',
        input: z.object({
          package: z.string(),
          name: z.string().describe('Exported name, `default` for the default export'),
          version: versionArg,
          subpath: z
            .string()
            .optional()
            .describe('Entry point; default: the first one exporting the name'),
          repo: repoArg,
        }),
        run: async ({ package: pkgName, name, version, subpath, repo }) => {
          const found = await catalog.resolve(canRead, pkgName, {
            ...(version ? { version } : {}),
            ...(repo ? { repo } : {}),
          })
          if (!found) throw await notFound(pkgName, version)
          const entry = found.package.entries.find(
            (item) =>
              (!subpath || item.subpath === subpath) && item.symbols.some((s) => s.name === name),
          )
          const symbol = entry?.symbols.find((s) => s.name === name)
          if (!entry || !symbol)
            throw new ToolError(
              `${pkgName}${found.package.version ? `@${found.package.version}` : ''} exports no ${name}${subpath ? ` from ${subpath}` : ''}; try search_symbols.`,
            )
          const from = importPath(pkgName, entry.subpath)
          const statement =
            name === 'default'
              ? `import ${pkgName.split('/').pop()?.replace(/\W+/g, '_') ?? 'value'} from '${from}'`
              : `import ${['interface', 'type'].includes(symbol.kind) ? 'type ' : ''}{ ${name} } from '${from}'`
          return [
            `${pkgName}${found.package.version ? `@${found.package.version}` : ''}, repo \`${repoKey(found.record.repo)}\``,
            ...(found.removed ? [removalNote(pkgName, found.record.repo, found.removed)] : []),
            `\`\`\`ts\n${statement}\n\`\`\``,
            renderSymbol(symbol),
          ].join('\n\n')
        },
        subject: ({ package: name }) => name,
      }),

      defineTool({
        name: 'list_versions',
        description:
          'Recorded versions of a package, newest first, with the release tag, date, number of exports and for the newest ones how the API changed from the version before (removed / changed / added).',
        input: z.object({ package: z.string(), repo: repoArg, ecosystem: ecosystemArg }),
        run: async ({ package: name, repo, ecosystem }) => {
          const found =
            ecosystem === 'Go'
              ? undefined
              : await catalog.resolve(canRead, name, repo ? { repo } : {})
          if (!found) {
            const ref = refOf(name, ecosystem)
            const external = await externalVersion(ref, undefined, repo)
            if (!external) throw await notFound(name)
            const lines = [
              `# ${name} (${ref.ecosystem}, third-party; versions with an indexed API)`,
            ]
            for (const [index, version] of external.versions.entries()) {
              const record = external.records.find((item) => item.version === version)
              const previous = external.versions[index + 1]
              let change = ''
              if (index < 10 && previous) {
                // oxlint-disable-next-line no-await-in-loop -- a few versions
                const [before, after] = await Promise.all([
                  library?.api.get(ref, previous),
                  library?.api.get(ref, version),
                ])
                if (before && after) {
                  const totals = { removed: 0, changed: 0, added: 0 }
                  for (const pkgName of new Set([...before, ...after].map((pkg) => pkg.name))) {
                    const diff = diffPackage(
                      before.find((pkg) => pkg.name === pkgName),
                      after.find((pkg) => pkg.name === pkgName),
                    )
                    totals.removed += diff.removed
                    totals.changed += diff.changed
                    totals.added += diff.added
                  }
                  change = ` — since ${previous}: ${totals.removed} removed, ${totals.changed} changed, ${totals.added} added`
                }
              }
              lines.push(
                `- ${version}${record?.roles.length ? ` (${record.roles.join(', ')})` : ''}${record?.publishedAt ? `, ${record.publishedAt.slice(0, 10)}` : ''}${record?.deprecated ? ', **deprecated**' : ''}${change}`,
              )
            }
            lines.push('Call library_versions for every indexed version and who uses which.')
            return lines.join('\n')
          }
          const lines = [
            `# ${name} in \`${repoKey(found.record.repo)}\``,
            ...(found.removed ? [removalNote(name, found.record.repo, found.removed)] : []),
          ]
          const versions = found.versions
          for (const [index, version] of versions.entries()) {
            let change = ''
            const previous = versions.slice(index + 1).find((v) => !v.head)
            if (index < 10 && previous) {
              // oxlint-disable-next-line no-await-in-loop -- a few versions from a small cache
              const [after, before] = await Promise.all([
                catalog.resolve(canRead, name, {
                  version: version.analysisId,
                  repo: repoKey(found.record.repo),
                }),
                catalog.resolve(canRead, name, {
                  version: previous.analysisId,
                  repo: repoKey(found.record.repo),
                }),
              ])
              if (after && before) {
                const diff = diffPackage(before.package, after.package)
                change = ` — since ${previous.version}: ${diff.removed} removed, ${diff.changed} changed, ${diff.added} added${diff.semverWarning ? ` (semver: ${diff.semverWarning})` : ''}`
              }
            }
            lines.push(
              `- ${version.head ? `head (default branch, package.json ${version.version})` : version.version}${version.ref ? ` tag \`${version.ref}\`` : ''}, ${version.analyzedAt.slice(0, 10)}, ${version.exports} exports${change}`,
            )
          }
          if (found.alsoIn.length)
            lines.push(
              `Also in: ${found.alsoIn.map((r) => `\`${repoKey(r)}\``).join(', ')} (pass \`repo\`).`,
            )
          return lines.join('\n')
        },
        subject: ({ package: name }) => name,
      }),

      defineTool({
        name: 'diff_versions',
        description:
          'What changed in a package’s public API between two versions: removed, changed (before and after declarations), deprecated and added exports, the version bump that calls for and whether the real bump matches semver. `from` defaults to the release before `to`; `to` defaults to the newest release.',
        input: z.object({
          package: z.string(),
          from: z.string().optional().describe('Older version or tag'),
          to: versionArg,
          repo: repoArg,
          ecosystem: ecosystemArg,
        }),
        run: async ({ package: name, from, to, repo, ecosystem }) => {
          const query = {
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
            ...(repo ? { repo } : {}),
          }
          const result = ecosystem === 'Go' ? undefined : await catalog.diff(canRead, name, query)
          if (!result) {
            const found =
              ecosystem === 'Go'
                ? undefined
                : await catalog.resolve(canRead, name, repo ? { repo } : {})
            if (!found) {
              const ref = refOf(name, ecosystem)
              const external = await externalDiff(ref, query)
              if (!external) throw await notFound(name)
              const changed = external.diffs.filter((diff) => diff.changes.length)
              return changed.length
                ? thirdParty(
                    `${name} ${external.from} → ${external.to} (${ref.ecosystem}, API from the published packages)`,
                    changed.map((diff) => renderDiff(diff)).join('\n\n'),
                  )
                : `${name}: no export changed between ${external.from} and ${external.to}.`
            }
            throw new ToolError(
              `Could not find both versions of ${name}; recorded: ${found.versions.map((v) => (v.head ? 'head' : v.version)).join(', ')}.`,
            )
          }
          return result.diff.changes.length
            ? renderDiff(result.diff)
            : `${name}: no export changed between ${result.from.version} and ${result.to.version}.`
        },
        subject: ({ package: name }) => name,
      }),

      defineTool({
        name: 'package_usage',
        description:
          'Who uses a package across the organization’s repositories: versions in use per repository and every export used with how often, how (call, jsx, type, member, …), the JSX props passed and members read. Start here before changing or upgrading a package.',
        input: z.object({ package: z.string().describe('Package name, e.g. @acme/ui') }),
        run: async ({ package: name }) => {
          const usage = packageUsage(await usages.entries(canRead), name)
          return renderPackageUsage(usage, { originLabel: String, teamOf })
        },
        subject: ({ package: name }) => name,
      }),

      defineTool({
        name: 'find_usages',
        description:
          'The code that uses a package: file, line and a snippet for each use, grouped by repository. Narrow with `export`, `member` (e.g. `reset` or `().reset` for the result of a call), `prop` (a JSX prop) or `kind`. Records keep a sample of sites per export; counts in package_usage cover all of them.',
        input: z.object({
          package: z.string(),
          export: z.string().optional().describe('Exported name, `default` or `*` for the module'),
          member: z.string().optional().describe('Member path read from the export'),
          prop: z.string().optional().describe('JSX prop passed to the export'),
          kind: z.enum(usageKinds).optional(),
          repo: z.string().optional().describe('Only this repository, as forge:path'),
          limit: z.number().int().min(1).max(100).optional().describe('Default 30'),
        }),
        defaultLimit: 30,
        run: async ({ package: name, export: exported, member, prop, kind, repo, limit }) => {
          const entries = await usages.entries(canReadSnippets)
          if (repo && !entries.some((entry) => entry.origin === repo))
            throw new ToolError(
              `No usage record of ${repo}; call repo_packages without arguments to see what is indexed.`,
            )
          return renderSites(
            findSites(entries, {
              package: name,
              ...(exported ? { export: exported } : {}),
              ...(member ? { member } : {}),
              ...(prop ? { prop } : {}),
              ...(kind ? { kind } : {}),
              ...(repo ? { origins: [repo] } : {}),
              limit: limit ?? 30,
            }),
            String,
            teamOf,
          )
        },
        subject: ({ package: name }) => name,
      }),

      defineTool({
        name: 'upgrade_impact',
        description:
          'What upgrading a package breaks in the repositories that use it: the API diff between two recorded versions joined with their uses. Removed exports and removed members or props of changed declarations are `breaking`, other uses of changed declarations `check`, deprecations `deprecated`; each comes with the affected code. Repositories already on `to` are left out.',
        input: z.object({
          package: z.string(),
          from: z.string().optional().describe('Older version; default the release before `to`'),
          to: versionArg,
          repo: repoArg,
          ecosystem: ecosystemArg,
        }),
        run: async ({ package: name, from, to, repo, ecosystem }) => {
          if (ecosystem === 'Go')
            throw new ToolError(
              'upgrade_impact covers npm packages (the usage index reads TypeScript and JavaScript); use diff_versions for Go modules.',
            )
          const query = {
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
            ...(repo ? { repo } : {}),
          }
          const result = await impactOf(catalog, usages, canReadSnippets, name, query)
          if (!result) {
            const found = await catalog.resolve(canRead, name, repo ? { repo } : {})
            if (!found) {
              const ref = refOf(name, 'npm')
              const external = await externalDiff(ref, query)
              if (!external) throw await notFound(name)
              const impact = await impactOfChanges(usages, canReadSnippets, name, {
                before: external.before.find((pkg) => pkg.name === name) ?? external.before[0],
                changes: external.diffs.flatMap((diff) => diff.changes),
                target: external.to,
              })
              return [
                `${name} ${external.from} → ${external.to} (third-party)`,
                renderImpact(impact),
              ].join('\n\n')
            }
            throw new ToolError(
              `Could not find both versions of ${name}; recorded: ${found.versions.map((v) => (v.head ? 'head' : v.version)).join(', ')}.`,
            )
          }
          return [
            `${name} ${result.from.version} → ${result.to.version} (\`${repoKey(result.repo)}\`)`,
            renderImpact(result.impact),
          ].join('\n\n')
        },
        subject: ({ package: name }) => name,
      }),

      defineTool({
        name: 'repo_packages',
        description:
          'The packages one repository’s code imports, with resolved versions, declared ranges, number of uses and exports used. Without `repo`, lists the repositories that have a usage record.',
        input: z.object({ repo: z.string().optional().describe('Repository as forge:path') }),
        run: async ({ repo }) => {
          const entries = await usages.entries(canRead)
          if (!repo)
            return entries.length
              ? entries
                  .map((entry) => `- \`${entry.origin}\`: ${entry.data.packages.length} packages`)
                  .join('\n')
              : 'No repository has a usage record yet.'
          const entry = entries.find((item) => item.origin === repo)
          if (!entry) throw new ToolError(`No usage record of ${repo}.`)
          const packages = repoPackages(entry.data)
          return [
            `# \`${repo}\`: ${packages.length} packages, ${entry.data.files} files read, type checker ${entry.data.types.status}`,
            ...packages.map(
              (pkg) =>
                `- **${pkg.name}** ${pkg.versions.join(', ') || pkg.ranges.join(', ') || 'version unknown'}${pkg.local ? ' (defined here)' : ''} — ${pkg.count} uses in ${pkg.files} files, ${pkg.exports} exports`,
            ),
          ].join('\n')
        },
        subject: ({ repo }) => repo,
      }),

      defineTool({
        name: 'evaluate_dependency',
        description:
          'Everything the organization knows about a dependency before you add or upgrade it: which repositories use it at which versions (and whether it is an internal package), deprecations, advisories from the newest audits with fixed versions, licenses with each repository’s verdict (and the verdict under `repo`’s policy), its gzip share of measured bundles, and accepted team knowledge about it. Reads stored analyses only.',
        input: z.object({
          package: z
            .string()
            .min(1)
            .describe('Package name, e.g. date-fns or github.com/spf13/cobra'),
          ecosystem: z.enum(['npm', 'Go']).optional().describe('Default npm'),
          version: z
            .string()
            .min(1)
            .optional()
            .describe('The version you consider; advisories seen at it are marked'),
          repo: z
            .string()
            .optional()
            .describe(
              'The repository you would add it to, as forge:path; its license policy applies',
            ),
        }),
        run: async (input) =>
          evaluateDependency(
            {
              analyses: context.store.analyses,
              auditRuns: context.store.auditRuns,
              catalog,
              usages,
              canRead,
              canReadAnalyses: context.canReadAnalyses,
              canReadAudits: context.canReadAudits,
              ...(context.auditOff ? { auditOff: context.auditOff } : {}),
              knowledge: context.knowledge,
              ...(context.ownerOf ? { ownerOf: context.ownerOf } : {}),
              ...(context.latest ? { latest: context.latest } : {}),
              ...(library ? { libraries: library.store } : {}),
            },
            input,
          ),
        subject: ({ package: name }) => name,
      }),

      defineTool({
        name: 'who_uses',
        description:
          'Which teams and repositories use a library, an internal package or a stack tool, at which versions, and how far behind the latest release each is — one call for "who uses what". Pass npm:<name>, Go:<module>, tool:<name> or a bare name (npm first, then Go, then stack tools).',
        input: z.object({
          subject: z
            .string()
            .min(1)
            .describe('npm:date-fns, Go:example.com/kit, tool:node or a bare name'),
        }),
        run: ({ subject }) =>
          whoUses(
            {
              analyses: context.store.analyses,
              catalog,
              usages,
              canRead,
              ownerOf: context.ownerOf ?? (() => []),
              ...(context.latest ? { latest: context.latest } : {}),
              ...(context.stack ? { stack: context.stack } : {}),
            },
            subject,
          ),
        subject: ({ subject }) => subject,
      }),
      ...(context.supply ? supplyTools(context.supply) : []),
    ],
  }
}
