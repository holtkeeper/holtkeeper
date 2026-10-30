import type { RepoTarget } from '@holtkeeper/access'
import type { KnowledgeKind, KnowledgePackage } from '@holtkeeper/store'
import { knowledgeWords } from '@holtkeeper/store'

import type { TaskPackage } from './model.ts'
import { compatibleRange } from './semver.ts'

/** What a proposal says about itself; missing parts are filled in by `classifyProposal`. */
export interface ClassifiableEntry {
  title: string
  body: string
  kind?: KnowledgeKind
  topics?: string[]
  appliesTo?: string[]
  packages?: KnowledgePackage[]
}

/** The task that produced the proposal. */
export interface ClassifyHints {
  taskKind?: string
  repo?: RepoTarget
  /** Packages the task updates, with versions before and after. */
  packages?: TaskPackage[]
}

/** The filled-in classification. `appliesTo` is never empty. */
export interface Classification {
  kind: KnowledgeKind
  topics: string[]
  appliesTo: string[]
  packages?: KnowledgePackage[]
}

const topicWords: Record<string, string[]> = {
  testing: [
    'test',
    'tests',
    'testing',
    'spec',
    'specs',
    'jest',
    'vitest',
    'mock',
    'mocks',
    'mocking',
    'coverage',
    'fixture',
    'fixtures',
    'snapshot',
    'snapshots',
    'e2e',
    'playwright',
  ],
  i18n: [
    'i18n',
    'l10n',
    'translation',
    'translations',
    'locale',
    'locales',
    'localization',
    'localisation',
    'plural',
    'plurals',
  ],
  security: [
    'security',
    'xss',
    'csrf',
    'cve',
    'vulnerability',
    'vulnerabilities',
    'secret',
    'secrets',
    'sanitize',
    'auth',
  ],
  performance: [
    'performance',
    'perf',
    'slow',
    'latency',
    'memoize',
    'memoization',
    'rerender',
    'rerenders',
  ],
  build: [
    'build',
    'bundler',
    'webpack',
    'vite',
    'esbuild',
    'rollup',
    'tsconfig',
    'babel',
    'compile',
  ],
  dependencies: ['dependency', 'dependencies', 'upgrade', 'upgrades', 'lockfile', 'semver', 'peer'],
  ci: ['ci', 'pipeline', 'pipelines', 'runner'],
  release: ['release', 'releases', 'changelog', 'deploy', 'deployment', 'rollout'],
  api: ['api', 'endpoint', 'endpoints', 'graphql', 'rest', 'grpc'],
  style: ['lint', 'eslint', 'oxlint', 'prettier', 'oxfmt', 'formatting', 'naming'],
}

const kindPatterns: [KnowledgeKind, RegExp][] = [
  [
    'migration',
    /\b(migrat\w*|upgrad\w*|breaking changes?|deprecat\w*|codemod|no longer|renamed|removed in)\b/,
  ],
  [
    'quirk',
    /\b(quirk|workaround|gotcha|beware|careful|flaky|surpris\w*|unexpected\w*|bug in|does not work|doesn't work|silently)\b/,
  ],
  ['howto', /\b(how to|steps?|run `|to do this|first,|then run|in order to)\b/],
  ['convention', /\b(always|never|prefer|must|should|naming|convention|style|instead of)\b/],
]

const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether `text` mentions `name` (or the last segment of a scoped/path name) as a whole word. */
function mentions(text: string, name: string): boolean {
  const lower = name.toLowerCase()
  const tail = lower.split('/').at(-1) ?? lower
  return [lower, ...(tail.length >= 3 && tail !== lower ? [tail] : [])].some((candidate) =>
    new RegExp(`(?<![\\w@/.-])${escapeRegExp(candidate)}(?![\\w/-])`).test(text),
  )
}

const packageFromTask = (pkg: TaskPackage): KnowledgePackage => {
  const from = pkg.from === undefined ? undefined : compatibleRange(pkg.from)
  const to = pkg.to === undefined ? undefined : compatibleRange(pkg.to)
  return {
    ecosystem: pkg.ecosystem,
    name: pkg.name,
    ...(from !== undefined && { from }),
    ...(to !== undefined && { to }),
  }
}

/**
 * Fills in kind, topics, task kinds and packages of a proposal from its text and from the task
 * that proposed it. Values the proposal already has are kept. Pure and deterministic.
 *
 * - Packages: task packages the text mentions, with ranges from the task's versions (react
 *   18.3.1 → 19.0.0 becomes `from: '>=18 <19', to: '>=19 <20'`).
 * - Kind: `migration` when such a package is found during a propagate or port task, or the text
 *   talks about upgrading; then quirk, how-to and convention by wording; `decision` otherwise.
 * - Topics: keyword families (`testing`, `i18n`, `security`, ...).
 * - Task kinds: the proposing task's kind plus kinds implied by kind and topics, `*` when nothing
 *   narrows it.
 */
export function classifyProposal(
  entry: ClassifiableEntry,
  hints: ClassifyHints = {},
): Classification {
  const text = `${entry.title}\n${entry.body}`.toLowerCase()
  const words = new Set(knowledgeWords(text))

  const mentioned = (hints.packages ?? []).filter((pkg) => mentions(text, pkg.name))
  let packages = entry.packages?.length ? entry.packages : mentioned.map(packageFromTask)

  const migrationTask = hints.taskKind === 'propagate' || hints.taskKind === 'port'
  const kind: KnowledgeKind =
    entry.kind ??
    (mentioned.length && migrationTask
      ? 'migration'
      : (kindPatterns.find(
          ([candidate, pattern]) =>
            pattern.test(text) && (candidate !== 'migration' || packages.length > 0),
        )?.[0] ?? 'decision'))
  if (kind === 'migration' && !packages.length)
    packages = (hints.packages ?? []).map(packageFromTask)

  const topics = new Set((entry.topics ?? []).map((topic) => topic.toLowerCase()))
  for (const [topic, list] of Object.entries(topicWords))
    if (list.some((word) => words.has(word))) topics.add(topic)
  if (kind === 'migration') topics.add('dependencies')

  let appliesTo = entry.appliesTo?.length ? entry.appliesTo : undefined
  if (!appliesTo) {
    const kinds = new Set<string>()
    if (hints.taskKind) kinds.add(hints.taskKind)
    if (kind === 'migration') for (const k of ['propagate', 'port', 'review']) kinds.add(k)
    if (kind === 'convention') for (const k of ['review', 'quality']) kinds.add(k)
    if (topics.has('testing')) kinds.add('tests')
    if (topics.has('release')) kinds.add('release-risk')
    appliesTo = kind === 'quirk' || kind === 'howto' || !kinds.size ? ['*'] : [...kinds]
  }

  return {
    kind,
    topics: [...topics],
    appliesTo,
    ...(packages.length > 0 && { packages }),
  }
}
