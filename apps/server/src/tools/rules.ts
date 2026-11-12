import type { RepoTarget } from '@holtkeeper/access'
import {
  type RegistryTool,
  type RegistryToolset,
  ToolError,
  defineTool,
} from '@holtkeeper/agent-tools'
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
  type GuideChainLayer,
  type GuideTask,
  LEARNING_RULE_MAX,
  LearningScopeError,
  type ResolvedGuide,
  type RuleProposalOutcome,
  chainLayers,
  chainTaskOf,
  guideSectionLabels,
  guideSections,
  guideTasks,
  testIdsSettingKey,
} from '@holtkeeper/guide'
import type {
  GuideScopeKey,
  GuideSectionName,
  LearningScopeKind,
  SettingStore,
  Store,
} from '@holtkeeper/store'
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
import { webPaths } from '@holtkeeper/web-paths'
import { z } from 'zod'

import { applyingEntry } from '../setting-rules.ts'

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

/** The Guide as `repo_rules` reads it, for one caller. */
interface GuideRulesAccess {
  /**
   * The Guide of `repo` (`forge:path`) for a task, from the same resolver internal agents use;
   * `undefined` when the caller may not read that repository's rules.
   */
  resolve(
    repo: string,
    request: {
      task: GuideTask
      section?: GuideSectionName
      focus?: readonly GuideSectionName[]
    },
  ): Promise<ResolvedGuide | undefined>
}

/** Where `propose_rule_change` stores proposals, for one caller. */
interface RuleProposalAccess {
  /**
   * Stores a proposal for people to review, or accepts it when `learnings.autoAccept` allows (the
   * candidate then comes back `accepted`); `undefined` when the caller may not propose for `repo`.
   */
  propose(
    repo: string,
    input: {
      section: GuideSectionName
      rule: string
      reason: string
      scope?: LearningScopeKind
      /** An exact scope of the repository; throws `LearningScopeError` for any other. */
      targetScope?: GuideScopeKey
    },
  ): Promise<RuleProposalOutcome | undefined>
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

/** What the `rules` toolset reads; each part adds its tools. */
export interface RulesAccess {
  /** `commit_conventions` and `check_commit_message`. */
  commits?: CommitConventionsAccess
  /** `repo_rules`. */
  guide?: GuideRulesAccess
  /** `propose_rule_change`. */
  proposals?: RuleProposalAccess
  /** `test_ids` and `suggest_test_ids`. */
  testIds?: TestIdsAccess
}

const repoArg = z.string().min(1).describe('The repository, as forge:path')

/** Numbered layers as `repo_rules` lists them under the Guide text. */
const renderChainLayers = (layers: readonly GuideChainLayer[]): string =>
  [
    'Layers, in the order you read them (higher wins over lower; people over generated):',
    ...layers.map(
      (layer) =>
        `${layer.n}. ${layer.source} (${layer.kind}${layer.version ? ` v${layer.version}` : ''}${layer.proposed ? ', proposed' : ''}): ${layer.chars} chars${layer.cut ? `, cut from ${layer.fullChars}` : ''}`,
    ),
  ].join('\n')

const noRepo = (repo: string) =>
  new ToolError(`No readable repository ${repo}; pass forge:path, e.g. gitlab:group/app.`)

function guideTools(access: GuideRulesAccess): RegistryTool[] {
  return [
    defineTool({
      name: 'repo_rules',
      description:
        "The team's rules for a repository (its Guide): team rules from the repository, its family, its groups and the whole organization, learned rules, policies such as commit conventions, generated text marked lower priority, then relevant knowledge notes. Human rules always win over generated text. Call it before changing code in a repository; the repository's own rules files (AGENTS.md, CLAUDE.md, ...) are not included, read them from the checkout.",
      input: z.object({
        repo: repoArg,
        task: z
          .enum(guideTasks)
          .optional()
          .describe(
            'What you are doing: agent (writing code, the default), review, chat or release-notes',
          ),
        section: z
          .enum(guideSections)
          .optional()
          .describe('The topic of the work besides general rules, e.g. testing or testids'),
        only: z
          .enum(guideSections)
          .optional()
          .describe(
            'Read just this section with its layers, as Knowledge › Guide shows it; overrides task and section',
          ),
      }),
      run: async ({ repo, task, section, only }) => {
        const topic = only ?? section
        const resolved = await access.resolve(
          repo,
          only
            ? { task: chainTaskOf(only), focus: [only] }
            : { task: task ?? 'agent', ...(section && { section }) },
        )
        if (!resolved) throw noRepo(repo)
        if (!resolved.text.trim())
          return `No team rules apply to \`${repo}\` yet${topic ? ` for ${guideSectionLabels[topic]}` : ''}; follow the repository's own rules files and its existing code.`
        return [
          `# Rules for \`${repo}\``,
          resolved.text.trim(),
          renderChainLayers(chainLayers(resolved)),
          ...(resolved.warnings.length ? [`Notes: ${resolved.warnings.join(' ')}`] : []),
        ].join('\n\n')
      },
      subject: ({ repo }) => repo,
    }),
  ]
}

const isScopeKind = (value: string): value is LearningScopeKind =>
  value === 'repo' || value === 'family' || value === 'group'

function proposalTools(access: RuleProposalAccess): RegistryTool[] {
  return [
    defineTool({
      name: 'propose_rule_change',
      description:
        "Proposes a rule for a repository's Guide: one imperative sentence people review under Knowledge → Learnings before any agent sees it, unless the team auto-accepts proposed rules. It never edits team rules, and a rule the repository already has a candidate for is not added again. Use it when a lasting convention is missing or wrong, not for one-off facts (propose_knowledge is for notes).",
      input: z.object({
        repo: z.string().min(1).describe('The repository the rule comes from, as forge:path'),
        section: z
          .enum(guideSections)
          .describe(
            'review for what reviews should (not) flag; general, testing, testids, assets, commits or releases otherwise',
          ),
        rule: z
          .string()
          .min(1)
          .max(LEARNING_RULE_MAX)
          .describe('One imperative sentence, e.g. "Keep shape sizes in ShapeSize."'),
        reason: z
          .string()
          .min(1)
          .max(1000)
          .describe('Why the rule is needed, with the evidence you saw'),
        scope: z
          .union([
            z.enum(['repo', 'family', 'group']),
            z.templateLiteral([z.enum(['group', 'family', 'repo']), ':', z.string().min(1)]),
          ])
          .optional()
          .describe(
            'Where it should apply once accepted (default repo): repo, family, group (the nearest group, a subgroup when there is one), or an exact scope of the repository such as group:<key> for a parent group, family:<id> or repo:<forge:path>',
          ),
      }),
      readOnly: false,
      run: async ({ repo, section, rule, reason, scope }) => {
        const outcome = await access
          .propose(repo, {
            section,
            rule,
            reason,
            ...(scope && (isScopeKind(scope) ? { scope } : { targetScope: scope })),
          })
          .catch((error: unknown) => {
            if (error instanceof LearningScopeError)
              throw new ToolError(`Not proposed: ${error.message}.`)
            throw error instanceof Error && error.message === 'the rule is empty'
              ? new ToolError('Not proposed: the rule is empty.')
              : error
          })
        if (!outcome) throw noRepo(repo)
        const { candidate } = outcome
        if (outcome.status === 'proposed' && candidate.status === 'accepted')
          return `Accepted "${candidate.rule}" for ${guideSectionLabels[candidate.section]} of \`${repo}\` into ${candidate.acceptedScope ?? 'its scope'} without review (learnings auto-accept is on); agents use it from now on. People can reject it in Knowledge › Learnings (${webPaths.knowledge('learnings', { space: `repo:${repo}` })}).`
        return outcome.status === 'exists'
          ? `Not added: \`${repo}\` already has this rule as a ${candidate.status} candidate: "${candidate.rule}".`
          : `Proposed "${candidate.rule}" for ${guideSectionLabels[candidate.section]} of \`${repo}\`${candidate.targetScope ? ` into ${candidate.targetScope}` : ''}. People review it in Knowledge › Learnings (${webPaths.knowledge('learnings', { space: `repo:${repo}` })}) before agents use it.`
      },
      subject: ({ repo }) => repo,
    }),
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
  return [
    defineTool({
      name: 'test_ids',
      description:
        "A repository's test id convention (attribute, naming, which elements get ids; learned from its code, team settings on top) and the existing test ids per component, for writing end-to-end tests or new UI. Narrow with path: a component file, a folder or a component name.",
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
      }),
      defaultLimit: 20,
      run: async ({ repo, path, limit }) => {
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
    defineTool({
      name: 'suggest_test_ids',
      description:
        "Lists the interactive elements of one component file that have no test id yet, each with an id suggested in the repository's naming style. Deterministic: pass the file's current text, saved or not.",
      input: z.object({
        repo: repoArg,
        file: z
          .string()
          .min(1)
          .describe('Path of the file in the repository, e.g. src/cart/CartRow.tsx'),
        content: z.string().max(400_000).describe("The file's current text"),
      }),
      run: async ({ repo, file, content }) => {
        const snapshot = await snapshotOf(repo)
        const convention = conventionOf(snapshot)
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
      },
      subject: ({ repo }) => repo,
    }),
  ]
}

function commitTools(access: CommitConventionsAccess): RegistryTool[] {
  const conventionsOf = async (repo: string, limit?: number) => {
    const found = await access.conventions(repo, limit)
    if (!found) throw noRepo(repo)
    return found
  }
  return [
    defineTool({
      name: 'commit_conventions',
      description:
        'How commit messages and branch names of a repository should look: a template, rules with where each comes from (team setting, forge push rules, commitlint, recent history), real examples that follow them and team notes. Use before committing, naming a branch or titling a merge request.',
      input: z.object({
        repo: repoArg,
        commits: z
          .number()
          .int()
          .min(20)
          .max(500)
          .optional()
          .describe('Recent commits of the default branch to learn from; default 100'),
      }),
      run: async ({ repo, commits }) => renderCommitConventions(await conventionsOf(repo, commits)),
      subject: ({ repo }) => repo,
    }),
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
 * The `rules` toolset: `repo_rules` (with `guide`), `propose_rule_change` (with `proposals`),
 * `commit_conventions` and `check_commit_message` (with `commits`), `test_ids` and
 * `suggest_test_ids` (with `testIds`), over the repositories `access` lets the caller read.
 * `undefined` when `access` has no part.
 */
export function rulesToolset(access: RulesAccess): RegistryToolset | undefined {
  const tools = [
    ...(access.guide ? guideTools(access.guide) : []),
    ...(access.proposals ? proposalTools(access.proposals) : []),
    ...(access.commits ? commitTools(access.commits) : []),
    ...(access.testIds ? testIdTools(access.testIds) : []),
  ]
  if (!tools.length) return undefined
  const instructions = [
    ...(access.guide
      ? [
          'Call repo_rules before changing code in a repository: it returns the team rules agents must follow there.',
        ]
      : []),
    ...(access.proposals
      ? ['propose_rule_change suggests a missing or wrong rule for people to review.']
      : []),
    ...(access.commits
      ? [
          [
            'Before writing a commit message, branch name or merge request title for a repository, call',
            'commit_conventions for its template, rules and real examples, and check_commit_message to',
            'verify the result.',
          ].join(' '),
        ]
      : []),
    ...(access.testIds
      ? [
          'For end-to-end tests and new UI, test_ids gives the test id convention and existing ids, and suggest_test_ids proposes ids for a file.',
        ]
      : []),
  ]
  return { name: 'rules', instructions: instructions.join(' '), tools }
}
