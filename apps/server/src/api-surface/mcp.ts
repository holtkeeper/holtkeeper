import type { Principal } from '@holtkeeper/access'
import {
  apiSymbolKinds,
  diffPackage,
  importPath,
  renderDiff,
  renderPackage,
  renderSymbol,
} from '@holtkeeper/api-surface'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'

import type { ApiCatalog, RepoFilter } from './catalog.ts'
import type { McpUsage } from './usage.ts'

/** Longest text a tool returns; agents get a hint to narrow the request instead. */
const maxText = 80_000

const instructions = [
  'Holtkeeper indexes the public API of the packages in this organization’s repositories: every',
  'exported name with its declaration and doc comment, for each released version and the default',
  'branch. Prefer it over reading package sources or node_modules.',
  'Start with search_symbols or list_packages, read get_package_api (narrow with subpath or',
  'docs: false for big packages), and use list_versions / diff_versions to see what changed',
  'between versions before upgrading.',
].join(' ')

const repoKey = (repo: { forge: string; path: string }) => `${repo.forge}:${repo.path}`

const text = (value: string) => ({
  content: [
    {
      type: 'text' as const,
      text:
        value.length > maxText
          ? `${value.slice(0, maxText)}\n\n…output truncated. Pass \`subpath\`, \`docs: false\` or use search_symbols / get_symbol for single names.`
          : value,
    },
  ],
})

class ToolError extends Error {}

/** Everything the MCP tools need for one request. */
export interface McpRequestContext {
  catalog: ApiCatalog
  usage: McpUsage
  principal: Principal
  /** Repositories the caller may read. */
  canRead: RepoFilter
  /** First word of the client's User-Agent. */
  client?: string
  now: () => Date
}

function buildServer(context: McpRequestContext) {
  const { catalog, canRead } = context
  const server = new McpServer({ name: 'holtkeeper', version: '1.0.0' }, { instructions })

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SDK's overloads infer arguments from its own zod typings; it validates them against the shape
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: {
      description: string
      inputSchema: z.ZodRawShape
      annotations: Record<string, boolean>
    },
    callback: (
      args: Record<string, unknown>,
    ) => Promise<ReturnType<typeof text> & { isError?: boolean }>,
  ) => void

  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<string>,
    subjectOf: (args: z.infer<z.ZodObject<Shape>>) => string | undefined,
  ) =>
    register(
      name,
      {
        description,
        inputSchema: shape,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (input) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SDK parsed `input` with `shape`
        const args = input as z.infer<z.ZodObject<Shape>>
        const started = performance.now()
        let ok = true
        try {
          return text(await handler(args))
        } catch (error) {
          ok = false
          const message = error instanceof Error ? error.message : String(error)
          return {
            ...text(error instanceof ToolError ? message : `Failed: ${message}`),
            isError: true,
          }
        } finally {
          const subject = subjectOf(args)
          context.usage.record({
            at: context.now().toISOString(),
            tool: name,
            principal: context.principal.id,
            name: context.principal.name,
            ...(context.client ? { client: context.client } : {}),
            ...(subject ? { subject } : {}),
            ok,
            durationMs: Math.round(performance.now() - started),
          })
        }
      },
    )

  const notFound = async (name: string, version?: string) => {
    const known = await catalog.packages(canRead)
    if (known.some((pkg) => pkg.name === name) && version)
      return new ToolError(
        `${name} has no version ${version}; call list_versions for the recorded ones.`,
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

  tool(
    'list_packages',
    'Lists the indexed packages (newest version of each) with their repository, description, entry points and how many versions are recorded. Filter with a substring of the name, description or repository.',
    {
      query: z
        .string()
        .optional()
        .describe('Substring of a package name, description or repository'),
    },
    async ({ query }) => {
      const packages = await catalog.packages(canRead, query)
      if (!packages.length)
        return query ? `No package matches "${query}".` : 'No package is indexed yet.'
      return packages
        .map(
          (pkg) =>
            `- **${pkg.name}**${pkg.version ? `@${pkg.version}` : ''}${pkg.private ? ' (private)' : ''}${pkg.description ? ` — ${pkg.description}` : ''}\n  repo \`${repoKey(pkg.repo)}\`${pkg.dir !== '.' ? ` folder \`${pkg.dir}\`` : ''}, ${pkg.exports} exports, entry points ${pkg.subpaths.map((s) => `\`${importPath(pkg.name, s)}\``).join(', ')}, ${pkg.versions} version${pkg.versions === 1 ? '' : 's'} recorded`,
        )
        .join('\n')
    },
    ({ query }) => query,
  )

  const versionArg = z
    .string()
    .optional()
    .describe(
      'Version such as 1.4.0, a tag, `latest` (newest release, default) or `head` (default branch)',
    )
  const repoArg = z
    .string()
    .optional()
    .describe('Repository as forge:path when several repositories have a package of that name')

  tool(
    'get_package_api',
    'The public API of one package version as Markdown: each entry point (import path) with every exported name, its doc comment and declaration. For large packages pass `subpath` or `docs: false`.',
    {
      package: z.string().describe('Package name, e.g. @acme/ui'),
      version: versionArg,
      subpath: z.string().optional().describe('Entry point such as `.` or `./button`'),
      docs: z.boolean().optional().describe('Include doc comments (default true)'),
      repo: repoArg,
    },
    async ({ package: name, version, subpath, docs, repo }) => {
      const found = await catalog.resolve(canRead, name, {
        ...(version ? { version } : {}),
        ...(repo ? { repo } : {}),
      })
      if (!found) throw await notFound(name, version)
      if (subpath && !found.package.entries.some((entry) => entry.subpath === subpath))
        throw new ToolError(
          `${name} has no entry point ${subpath}; it has ${found.package.entries.map((entry) => entry.subpath).join(', ')}.`,
        )
      const others = found.versions
        .filter((v) => v.analysisId !== found.version.analysisId)
        .slice(0, 8)
        .map((v) => (v.head ? 'head' : v.version))
      return [
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
    ({ package: name }) => name,
  )

  tool(
    'search_symbols',
    'Finds exported functions, classes, types and constants by name (exact, prefix, substring) or doc comment text across the newest version of every package. Returns import paths, declarations and the first line of docs.',
    {
      query: z.string().min(1).describe('Name or words to look for'),
      package: z.string().optional().describe('Only this package'),
      kind: z.enum(apiSymbolKinds).optional().describe('Only this kind of export'),
      limit: z.number().int().min(1).max(50).optional().describe('Default 20'),
    },
    async ({ query, package: name, kind, limit }) => {
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
    ({ package: name, query }) => name ?? query,
  )

  tool(
    'get_symbol',
    'One exported name of a package in full: doc comment, declaration, source location and the import statement to use.',
    {
      package: z.string(),
      name: z.string().describe('Exported name, `default` for the default export'),
      version: versionArg,
      subpath: z
        .string()
        .optional()
        .describe('Entry point; default: the first one exporting the name'),
      repo: repoArg,
    },
    async ({ package: pkgName, name, version, subpath, repo }) => {
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
        `\`\`\`ts\n${statement}\n\`\`\``,
        renderSymbol(symbol),
      ].join('\n\n')
    },
    ({ package: name }) => name,
  )

  tool(
    'list_versions',
    'Recorded versions of a package, newest first, with the release tag, date, number of exports and for the newest ones how the API changed from the version before (removed / changed / added).',
    { package: z.string(), repo: repoArg },
    async ({ package: name, repo }) => {
      const found = await catalog.resolve(canRead, name, repo ? { repo } : {})
      if (!found) throw await notFound(name)
      const lines = [`# ${name} in \`${repoKey(found.record.repo)}\``]
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
    ({ package: name }) => name,
  )

  tool(
    'diff_versions',
    'What changed in a package’s public API between two versions: removed, changed (before and after declarations), deprecated and added exports, the version bump that calls for and whether the real bump matches semver. `from` defaults to the release before `to`; `to` defaults to the newest release.',
    {
      package: z.string(),
      from: z.string().optional().describe('Older version or tag'),
      to: versionArg,
      repo: repoArg,
    },
    async ({ package: name, from, to, repo }) => {
      const result = await catalog.diff(canRead, name, {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(repo ? { repo } : {}),
      })
      if (!result) {
        const found = await catalog.resolve(canRead, name, repo ? { repo } : {})
        if (!found) throw await notFound(name)
        throw new ToolError(
          `Could not find both versions of ${name}; recorded: ${found.versions.map((v) => (v.head ? 'head' : v.version)).join(', ')}.`,
        )
      }
      return result.diff.changes.length
        ? renderDiff(result.diff)
        : `${name}: no export changed between ${result.from.version} and ${result.to.version}.`
    },
    ({ package: name }) => name,
  )

  return server
}

/**
 * Answers one request to the MCP endpoint (Streamable HTTP, stateless, JSON responses): a fresh
 * server per request with read-only tools over the API catalog, limited to the repositories the
 * caller may read. Every tool call is counted in `usage`.
 */
export async function handleMcpRequest(
  request: Request,
  context: McpRequestContext,
): Promise<Response> {
  const server = buildServer(context)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    void server.close()
  }
}
