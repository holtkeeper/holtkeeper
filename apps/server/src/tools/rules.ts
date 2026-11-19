import type { RepoTarget } from '@holtkeeper/access'
import {
  type RegistryTool,
  type RegistryToolset,
  ToolError,
  defineTool,
} from '@holtkeeper/agent-tools'
import { kindOfPath } from '@holtkeeper/assets'
import {
  type CommitConventions,
  type ConventionsForge,
  checkConventions,
  commitConventions,
  commitConventionsKey,
  commitConventionsSchema,
  renderCommitConventions,
  renderProblems,
} from '@holtkeeper/commit-conventions'
import {
  type RepoRuleFile,
  type ResolvedRules,
  type RuleBlock,
  scopeSource,
  testIdsSettingKey,
} from '@holtkeeper/rules'
import type { Learning, Rule, RuleAgent, SettingStore, Store } from '@holtkeeper/store'
import {
  type TestIdConvention,
  type TestIdOverrides,
  type TestIdsData,
  findUntaggedInText,
  learnTestIdOptions,
  renderTestIdConvention,
  testIdConvention,
  testIdOverridesOf,
  testIdsDataSchema,
} from '@holtkeeper/testids'
import { z } from 'zod'

import { applyingEntry } from '../setting-rules.ts'
import { type AssetToolsAccess, assetPolicy } from './assets.ts'
import { type ReleaseRulesAccess, releaseRules } from './releases.ts'

/** Commit conventions as the rules tools read them, for one caller. */
export interface CommitConventionsAccess {
  /** The conventions of `repo` (`forge:path`), or `undefined` when the caller may not read it. */
  conventions(repo: string, commits?: number): Promise<CommitConventions | undefined>
}

/** Inputs of `commitConventionsReader`. */
export interface CommitConventionsDeps {
  /** The forge client of a configured forge id; throws when the forge is unknown. */
  forgeOf: (forge: string) => ConventionsForge
  settings: Pick<SettingStore, 'list'>
  now: () => Date
  /** How long a result is reused. Default 10 minutes. */
  ttlMs?: number
}

const maxEntries = 500

/**
 * Commit conventions per repository, reused for `ttlMs` while the `commits.conventions` setting
 * that applies (resolved as `GET /api/settings/resolve` does) stays the same. Failed reads are not
 * kept.
 */
export function commitConventionsReader(deps: CommitConventionsDeps) {
  const ttl = deps.ttlMs ?? 10 * 60_000
  const cache = new Map<string, { at: number; value: Promise<CommitConventions> }>()

  return async (repo: RepoTarget, commits = 100): Promise<CommitConventions> => {
    const entry = applyingEntry(
      await deps.settings.list(commitConventionsKey),
      { key: commitConventionsKey },
      repo,
    )
    const parsed = commitConventionsSchema.safeParse(entry?.value)
    const setting = parsed.success && entry ? parsed.data : undefined
    const key = `${repo.forge}:${repo.path}:${commits}:${entry?.id ?? ''}:${entry?.updatedAt ?? ''}`
    const now = deps.now().getTime()
    const hit = cache.get(key)
    if (hit && now - hit.at < ttl) return hit.value

    const value = commitConventions({
      forge: deps.forgeOf(repo.forge),
      repo: repo.path,
      label: `${repo.forge}:${repo.path}`,
      ...(setting ? { setting } : {}),
      commits,
    })
    cache.set(key, { at: now, value })
    void value.catch(() => cache.delete(key))
    for (const [old, cached] of cache)
      if (cache.size > maxEntries || now - cached.at >= ttl) cache.delete(old)
    return value
  }
}

/** Rules as `repo_rules` and `get_rule` read them, for one caller. */
export interface RepoRulesAccess {
  /**
   * The resolved rules of `repo` (`forge:path`) for an agent run touching `files`, from the same
   * resolver internal agents use; `undefined` when the caller may not read that repository's
   * rules.
   */
  resolve(
    repo: string,
    request: { agent: RuleAgent; files?: readonly string[] },
  ): Promise<ResolvedRules | undefined>
  /** A panel rule by id, when the caller may read it. */
  rule(id: string): Promise<Rule | undefined>
  /** A learning by id, when the caller may read it. */
  learning(id: string): Promise<Learning | undefined>
  /** A rules file of `repo` by path, when the caller may read the repository's rules. */
  repoFile(repo: string, path: string): Promise<RepoRuleFile | undefined>
}

/** A repository's test id catalog and the team's overrides. */
export interface TestIdsSnapshot {
  /** The newest `testids` catalog; absent before the first analysis. */
  data?: TestIdsData
  analyzedAt?: string
  sha?: string
  overrides: TestIdOverrides
}

/** Test id catalogs as the rules tools read them, for one caller. */
interface TestIdsAccess {
  /** The snapshot of `repo` (`forge:path`), or `undefined` when the caller may not read it. */
  testIds(repo: string): Promise<TestIdsSnapshot | undefined>
}

/**
 * The test id snapshot of a repository: the newest `testids` record and the `analyzers.testids`
 * overrides that apply to it, resolved as `GET /api/settings/resolve` does. Records that fail the
 * catalog schema read as missing.
 */
export function testIdsReader(deps: { store: Pick<Store, 'analyses' | 'settings'> }) {
  return async (repo: RepoTarget): Promise<TestIdsSnapshot> => {
    const [[record], entries] = await Promise.all([
      deps.store.analyses.latest({ repo: { forge: repo.forge, path: repo.path }, kind: 'testids' }),
      deps.store.settings.list(testIdsSettingKey),
    ])
    const parsed = testIdsDataSchema.safeParse(record?.data)
    return {
      ...(parsed.success && record
        ? {
            data: parsed.data,
            analyzedAt: record.createdAt,
            ...(record.sha && { sha: record.sha }),
          }
        : {}),
      overrides: testIdOverridesOf(applyingEntry(entries, { key: testIdsSettingKey }, repo)?.value),
    }
  }
}

/** What the `rules` toolset reads; each part adds its tools and topics. */
export interface RulesAccess {
  /** `check_commit_message` and the `commits` topic of `repo_rules`. */
  commits?: CommitConventionsAccess
  /** The rules of `repo_rules`, and `get_rule`. */
  rules?: RepoRulesAccess
  /** `test_ids` and the `test-ids` topic of `repo_rules`. */
  testIds?: TestIdsAccess
  /** The `releases` topic of `repo_rules`. */
  releases?: ReleaseRulesAccess
  /** The `assets` topic of `repo_rules`. */
  assets?: AssetToolsAccess
}

/** Options of `rulesToolset`. */
export interface RulesToolsetOptions {
  /**
   * Whether `get_rule` is offered (default). The MCP endpoint leaves it out: its
   * `search_knowledge` reads a rule in full by `id`.
   */
  reader?: boolean
}

const repoArg = z.string().min(1).describe('The repository, as forge:path')

const noRepo = (repo: string) =>
  new ToolError(`No readable repository ${repo}; pass forge:path, e.g. gitlab:acme/app.`)

const renderBlocks = (blocks: readonly RuleBlock[]): string =>
  [
    'Blocks, strongest first:',
    ...blocks.map(
      (block) =>
        `- ${block.layer === 'rule' ? `[rule:${block.id}] ` : ''}${block.title} (${block.source}, ${block.activation}): ${block.text ? `${block.chars} chars${block.cut ? `, cut from ${block.fullChars}` : ''}` : 'left out for room'}`,
    ),
  ].join('\n')

const renderRequested = (resolved: ResolvedRules, readWith: string): string[] =>
  resolved.requested.length
    ? [
        [
          `Rules to read with ${readWith} when they fit the work:`,
          ...resolved.requested.map(
            (rule) =>
              `- \`${rule.source === rule.id ? rule.id : `rule:${rule.id}`}\`${rule.title === rule.id ? '' : ` ${rule.title}`}${rule.source === rule.id ? '' : ` (${rule.source})`}: ${rule.description}`,
          ),
        ].join('\n'),
      ]
    : []

const stripCitation = (id: string) => id.trim().replace(/^\[|\]$/g, '')

/**
 * One rule in full as Markdown: a panel rule (`rule:<id>` or a bare id), a learned rule
 * (`learn:<id>`) with its sources and counters, or a rules file of `repo` by path. Throws a
 * `ToolError` when the caller may read none of that name.
 */
export async function readRule(
  access: RepoRulesAccess,
  id: string,
  repo?: string,
): Promise<string> {
  const key = stripCitation(id)
  if (key.startsWith('learn:')) {
    const learning = await access.learning(key.slice('learn:'.length))
    if (!learning) throw new ToolError(`No learned rule ${key} you may read.`)
    return [
      `# [learn:${learning.id}] Learned rule (${learning.status})`,
      learning.text,
      ...(learning.reason ? [`Why: ${learning.reason}`] : []),
      [
        `- applies to: ${scopeSource(learning.scope)}${learning.files?.length ? `, files ${learning.files.map((glob) => `\`${glob}\``).join(', ')}` : ''}`,
        `- origin: ${learning.origin}; used ${learning.uses}×, fixed ${learning.actedOn}×, 👍 ${learning.votesUp} 👎 ${learning.votesDown}`,
        ...learning.sources.map(
          (source) =>
            `- source: ${source.url ?? `${source.repo ?? ''}${source.mergeRequest ? `!${source.mergeRequest}` : ''}`} (${source.at.slice(0, 10)})`,
        ),
      ].join('\n'),
    ].join('\n\n')
  }
  const ruleId = key.startsWith('rule:') ? key.slice('rule:'.length) : key
  if (repo && !key.startsWith('rule:')) {
    const file = await access.repoFile(repo, key)
    if (file) return `# ${file.path} (${repo})\n\n${file.text.trim()}`
  }
  const rule = await access.rule(ruleId)
  if (rule)
    return [
      `# [rule:${rule.id}] ${rule.title}`,
      [
        `- applies to: ${scopeSource(rule.scope)}${rule.files?.length ? `, files ${rule.files.map((glob) => `\`${glob}\``).join(', ')}` : ''}`,
        ...(rule.agents?.length ? [`- read by: ${rule.agents.join(', ')}`] : []),
        ...(rule.description ? [`- when: ${rule.description}`] : []),
        `- version ${rule.version}, updated ${rule.updatedAt.slice(0, 10)}`,
      ].join('\n'),
      rule.body.trim(),
    ].join('\n\n')
  throw new ToolError(
    repo
      ? `No rule or rules file ${key} in \`${repo}\`.`
      : `No rule ${key} you may read; pass repo for a rules file path.`,
  )
}

/** A convention `repo_rules` adds in full on request. */
interface RulesTopic {
  name: string
  /** What the topic covers, for the argument description. */
  covers: string
  render(repo: string, files: readonly string[]): Promise<string>
}

function topicsOf(access: RulesAccess): RulesTopic[] {
  const { commits, releases, assets, testIds } = access
  return [
    ...(commits
      ? [
          {
            name: 'commits',
            covers: 'commit message, branch name and merge request title conventions with examples',
            render: async (repo: string) => {
              const found = await commits.conventions(repo)
              if (!found) throw noRepo(repo)
              return renderCommitConventions(found)
            },
          },
        ]
      : []),
    ...(releases
      ? [
          {
            name: 'releases',
            covers: 'how the repository releases: branches, tags, version bumps, gates',
            render: (repo: string) => releaseRules(releases, repo),
          },
        ]
      : []),
    ...(assets
      ? [
          {
            name: 'assets',
            covers: 'formats, size and dimension limits for images, fonts, audio and video',
            render: (repo: string, files: readonly string[]) =>
              assetPolicy(
                assets,
                repo,
                files.filter((file) => kindOfPath(file) !== 'other').slice(0, 10),
              ),
          },
        ]
      : []),
    ...(testIds
      ? [
          {
            name: 'test-ids',
            covers: 'the test id attribute and naming convention',
            render: async (repo: string) => {
              const snapshot = await testIds.testIds(repo)
              if (!snapshot) throw noRepo(repo)
              const convention = conventionOf(snapshot)
              return convention
                ? renderTestIdConvention(convention)
                : `\`${repo}\` uses no test attributes${snapshot.data ? '' : ' yet: the testids analysis has not run there'}.`
            },
          },
        ]
      : []),
  ]
}

const topicTitles: Record<string, string> = {
  commits: 'Commit conventions',
  releases: 'Release rules',
  assets: 'Asset policy',
  'test-ids': 'Test ids',
}

function repoRulesTools(
  access: RulesAccess,
  options: { reader: boolean; readWith: string },
): RegistryTool[] {
  const rules = access.rules
  const topics = topicsOf(access)
  const [first, ...rest] = topics.map((topic) => topic.name)
  if (!rules && !first) return []
  return [
    defineTool({
      name: 'repo_rules',
      description: `The rules agents follow in a repository, resolved as Holtkeeper's own agents get them: rules people wrote in the panel for the organization, teams and repositories, the repository's rules files (AGENTS.md, CLAUDE.md, REVIEW.md, .github/instructions, .cursor/rules, ... including nested ones), policies, then learned rules, ranked below. Pass the files you change so path-scoped rules apply. Lists the blocks it used and rules to read on demand with ${options.readWith}.${first ? ' Add `topics` for a convention in full before you rely on it.' : ''} Call it before changing code in a repository.`,
      input: z.object({
        repo: repoArg,
        files: z
          .array(z.string().min(1))
          .max(200)
          .optional()
          .describe(
            'Repository-relative paths you touch; without them every path-scoped rule is listed',
          ),
        agent: z
          .enum(['review', 'task', 'chat', 'release'])
          .optional()
          .describe(
            'What you are doing: task (writing code, the default), review, chat or release',
          ),
        ...(first
          ? {
              topics: z
                .array(z.enum([first, ...rest]))
                .optional()
                .describe(
                  `Conventions to add in full: ${topics.map((topic) => `${topic.name} (${topic.covers})`).join('; ')}`,
                ),
            }
          : {}),
      }),
      run: async (input) => {
        const { repo, files, agent } = input
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `topics` is in the schema only when there are topics
        const wanted = (input as { topics?: string[] }).topics ?? []
        const sections: string[] = []
        let rulesServed = false
        if (rules) {
          const resolved = await rules
            .resolve(repo, { agent: agent ?? 'task', ...(files && { files }) })
            .catch((error: unknown) => {
              if (wanted.length && error instanceof ToolError) return error
              throw error
            })
          rulesServed = Boolean(resolved) && !(resolved instanceof ToolError)
          if (!resolved && !wanted.length) throw noRepo(repo)
          if (!resolved) sections.push(`You may not read the rules of \`${repo}\`.`)
          else if (resolved instanceof ToolError) sections.push(resolved.message)
          else if (!resolved.text.trim() && !resolved.requested.length)
            sections.push(`No rules apply to \`${repo}\` yet; follow its existing code.`)
          else
            sections.push(
              `# Rules for \`${repo}\``,
              ...(resolved.text.trim() ? [resolved.text.trim()] : []),
              ...renderRequested(resolved, options.readWith),
              renderBlocks(resolved.blocks),
              ...(resolved.warnings.length ? [`Notes: ${resolved.warnings.join(' ')}`] : []),
            )
        }
        let served = rulesServed
        for (const topic of topics.filter((item) => wanted.includes(item.name))) {
          const title = topicTitles[topic.name] ?? topic.name
          // oxlint-disable-next-line no-await-in-loop -- a few topics, kept in order
          const text = await topic.render(repo, files ?? []).catch((error: unknown) => {
            if (error instanceof ToolError) return undefined
            throw error
          })
          if (text !== undefined) served = true
          sections.push(
            `# ${title} of \`${repo}\``,
            text ?? `You may not read the ${title.toLowerCase()} of \`${repo}\`.`,
          )
        }
        if (!served && wanted.length) throw noRepo(repo)
        return sections.join('\n\n')
      },
      subject: ({ repo }) => repo,
    }),
    ...(rules && options.reader
      ? [
          defineTool({
            name: 'get_rule',
            description:
              'One rule in full: a panel rule ([rule:<id>]), a learned rule ([learn:<id>]) with its sources and counters, or a rules file of a repository by path (pass repo) such as one repo_rules offers to read on demand.',
            input: z.object({
              id: z
                .string()
                .min(1)
                .describe('rule:<id>, learn:<id>, a rule id, or a repository rules file path'),
              repo: z
                .string()
                .min(1)
                .optional()
                .describe('The repository, as forge:path, for a rules file path'),
            }),
            run: ({ id, repo }) => readRule(rules, id, repo),
            subject: ({ id, repo }) => repo ?? id,
          }),
        ]
      : []),
  ]
}

const conventionOf = (snapshot: TestIdsSnapshot): TestIdConvention | undefined =>
  testIdConvention(snapshot.data && learnTestIdOptions(snapshot.data), snapshot.overrides)

const selector = (attribute: { name: string; value: string; dynamic?: boolean }) =>
  attribute.dynamic
    ? `${attribute.name}={${attribute.value}}`
    : `${attribute.name}="${attribute.value}"`

const matchesPath = (file: string, name: string, path: string) =>
  file === path || file.startsWith(path.endsWith('/') ? path : `${path}/`) || name === path

function testIdTools(access: TestIdsAccess): RegistryTool[] {
  const snapshotOf = async (repo: string) => {
    const snapshot = await access.testIds(repo)
    if (!snapshot) throw noRepo(repo)
    return snapshot
  }
  const suggest = async (repo: string, file: string, content: string) => {
    const convention = conventionOf(await snapshotOf(repo))
    if (!convention) return `\`${repo}\` uses no test attributes, so new elements need none.`
    if (convention.exclude.some((glob) => new Bun.Glob(glob).match(file)))
      return `\`${file}\` is left out of test ids by the team's settings.`
    const found = await findUntaggedInText({
      file,
      text: content,
      attributes: convention.attributes,
      naming: convention.naming,
      ...(convention.elements && { tags: convention.elements }),
    })
    if (!found.length) return `Every interactive element of \`${file}\` has a test id.`
    const line = (element: (typeof found)[number]) =>
      `- L${element.line} \`<${element.tag}>\`${element.as && element.as !== element.tag ? ` (renders \`<${element.as}>\`)` : ''}, ${element.reason}: \`${convention.attribute}="${element.suggestion ?? ''}"\``
    const missing = found.filter((element) => element.status === 'missing')
    const unverified = found.filter((element) => element.status === 'unverified')
    return [
      `Test ids for \`${file}\` use \`${convention.attribute}\`.`,
      ...(missing.length ? [`Missing:\n${missing.map(line).join('\n')}`] : []),
      ...(unverified.length
        ? [
            `Spread props that may already pass one; check the callers:\n${unverified.map(line).join('\n')}`,
          ]
        : []),
    ].join('\n\n')
  }
  return [
    defineTool({
      name: 'test_ids',
      description:
        "A repository's test id convention (attribute, naming, which elements get ids; learned from its code, team settings on top) and the existing test ids per component, for writing end-to-end tests or new UI. Narrow with `path`: a component file, a folder or a component name. With `file` and `content` instead: the interactive elements of that one file that have no test id yet, each with an id suggested in the repository's naming style (deterministic; pass the file's current text, saved or not).",
      input: z.object({
        repo: repoArg,
        path: z
          .string()
          .min(1)
          .optional()
          .describe('A component file, a folder (src/cart) or a component name (LoginForm)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Components to list; default 20'),
        file: z
          .string()
          .min(1)
          .optional()
          .describe('To suggest ids: path of the file, e.g. src/cart/CartRow.tsx'),
        content: z
          .string()
          .max(400_000)
          .optional()
          .describe("To suggest ids: the file's current text"),
      }),
      defaultLimit: 20,
      run: async ({ repo, path, limit, file, content }) => {
        if (file !== undefined || content !== undefined) {
          if (!file || content === undefined)
            throw new ToolError('Pass both `file` and `content` to get suggested test ids.')
          return suggest(repo, file, content)
        }
        const snapshot = await snapshotOf(repo)
        const convention = conventionOf(snapshot)
        if (!snapshot.data && !convention)
          return `No test id catalog for \`${repo}\` yet: the testids analysis has not run there.`
        if (!convention) return `\`${repo}\` uses no test attributes.`
        const components = (snapshot.data?.components ?? []).filter(
          (component) => !path || matchesPath(component.file, component.name, path),
        )
        const shown = components.slice(0, limit ?? 20)
        return [
          `# Test ids of \`${repo}\`${snapshot.analyzedAt ? ` (catalog of ${snapshot.analyzedAt.slice(0, 10)}${snapshot.sha ? `, ${snapshot.sha.slice(0, 8)}` : ''})` : ''}`,
          renderTestIdConvention(convention),
          ...(shown.length
            ? shown.map((component) =>
                [
                  `## ${component.name} · ${component.file} (${component.total})`,
                  ...component.elements.map(
                    (element) =>
                      `- L${element.line} \`<${element.tag}>\` ${element.attributes.map(selector).join(' ')}`,
                  ),
                ].join('\n'),
              )
            : [
                path
                  ? `No component with test ids matches \`${path}\`.`
                  : 'No component has test ids yet.',
              ]),
          ...(components.length > shown.length
            ? [`…and ${components.length - shown.length} more components; narrow with path.`]
            : []),
        ].join('\n\n')
      },
      subject: ({ repo }) => repo,
    }),
  ]
}

function commitTools(access: CommitConventionsAccess): RegistryTool[] {
  const conventionsOf = async (repo: string) => {
    const found = await access.conventions(repo)
    if (!found) throw noRepo(repo)
    return found
  }
  return [
    defineTool({
      name: 'check_commit_message',
      description:
        'Checks a commit message and/or a branch name against the conventions of a repository; errors break configured or enforced rules, warnings only differ from what recent history does.',
      input: z.object({
        repo: repoArg,
        message: z
          .string()
          .min(1)
          .optional()
          .describe('The whole commit message or a merge request title'),
        branch: z.string().min(1).optional().describe('A branch name'),
      }),
      run: async ({ repo, message, branch }) => {
        if (!message && !branch) throw new ToolError('Pass message, branch or both.')
        const conventions = await conventionsOf(repo)
        return renderProblems(
          checkConventions(conventions, {
            ...(message && { message }),
            ...(branch && { branch }),
          }).map(({ target, problems }) => ({
            what: target === 'message' ? 'Message' : 'Branch',
            problems,
          })),
        )
      },
      subject: ({ repo }) => repo,
    }),
  ]
}

/**
 * The `rules` toolset over the repositories `access` lets the caller read: `repo_rules` (the
 * resolved rules with `rules`, plus the topics `commits`, `releases`, `assets` and `test-ids`
 * for the parts given), `get_rule` (with `rules`, unless `reader: false`), `check_commit_message`
 * (with `commits`) and `test_ids` (with `testIds`). `undefined` when `access` has no part.
 */
export function rulesToolset(
  access: RulesAccess,
  options: RulesToolsetOptions = {},
): RegistryToolset | undefined {
  const reader = options.reader ?? true
  const tools = [
    ...repoRulesTools(access, {
      reader,
      readWith: reader ? 'get_rule' : 'search_knowledge (pass `id`)',
    }),
    ...(access.commits ? commitTools(access.commits) : []),
    ...(access.testIds ? testIdTools(access.testIds) : []),
  ]
  if (!tools.length) return undefined
  const instructions = [
    ...(access.rules
      ? [
          `Call repo_rules with the files you change before changing code in a repository${reader ? '; get_rule reads one rule in full' : ''}.`,
        ]
      : []),
    ...(topicsOf(access).length
      ? ['Add its `topics` before committing, releasing or adding assets.']
      : []),
    ...(access.commits
      ? ['check_commit_message verifies commit messages, branch names and merge request titles.']
      : []),
    ...(access.testIds ? ['test_ids lists and suggests test ids.'] : []),
  ]
  return { name: 'rules', instructions: instructions.join(' '), tools }
}
