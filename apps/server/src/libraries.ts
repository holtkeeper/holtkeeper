import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Agent } from '@holtkeeper/agent'
import type { LibraryIndexRun } from '@holtkeeper/api'
import type { ArtifactStore } from '@holtkeeper/artifacts'
import { fleetDataSchema } from '@holtkeeper/fleet'
import {
  type GitHubClient,
  type GitHubEvent,
  type LibraryDocs,
  type LibraryIndexSettings,
  type LibraryRegistry,
  type LibraryUse,
  type Summarize,
  createGitHubClient,
  defaultLibraryIndexSettings,
  digestOnDemand,
  goRegistry,
  indexLibraries,
  libraryDocs,
  libraryIssues,
  liveIssueSearch,
  npmRegistry,
  siteSource,
  sourceSnapshots,
} from '@holtkeeper/libraries'
import { defineSetting } from '@holtkeeper/settings'
import type {
  AnalysisStore,
  KvStore,
  LibraryEcosystem,
  LibraryRef,
  LibraryStore,
  LibraryVersionRecord,
  SettingEntry,
  SettingStore,
} from '@holtkeeper/store'
import { newestRecords } from '@holtkeeper/store'
import { intervalMs } from '@holtkeeper/updates'
import { z } from 'zod'

import { createApiCatalog } from './api-surface/catalog.ts'
import { createUsageIndex } from './api-surface/usages.ts'
import { githubReferences, githubUsageFor, resolveGitHubTokens } from './github-usage.ts'
import { libraryProgressWriter } from './library-progress.ts'

const intervalPattern = /^([1-9]\d*)(m|h|d)$/
const MIN_INTERVAL_MS = 3_600_000
const DEFAULT_INTERVAL = '1d'
const LAST_RUN_KEY = 'libraries:last-run'
const REQUEST_KEY = 'libraries:reindex'
const RUNNING_KEY = 'libraries:running'
const TOKENS_KEY = 'libraries:tokens'

const tokensOf = async (credentials: CredentialSource, config: LibrariesConfig) =>
  JSON.stringify(await githubReferences(credentials, config.github))
const RUNNING_TTL_S = 900
const MAX_STORED_FAILURES = 200
const CHANGE_DEBOUNCE_MS = 600_000
const USE_KINDS = new Set(['usages', 'fleet'])

const globSchema = z.array(z.string().trim().min(1))

/** Value of the `libraries` setting; every field is optional. */
const librariesSchema = z.object({
  enabled: z.boolean().optional(),
  /** How often the index looks for new releases and uses. */
  interval: z
    .string()
    .refine((value) => intervalPattern.test(value), 'expected an interval such as 12h or 1d')
    .refine(
      (value) => (intervalMs(value) ?? 0) >= MIN_INTERVAL_MS,
      'indexing more often than hourly is not allowed',
    )
    .optional(),
  /**
   * Ids or names of credentials whose secrets are GitHub tokens, shared by every request; a
   * single string is read as a list of one. Unset: every credential of kind `github`; `[]`: none.
   */
  github: z
    .preprocess(
      (value) => (typeof value === 'string' ? [value] : value),
      z.array(z.string().trim().min(1).meta({ 'x-credential': 'github' })),
    )
    .optional(),
  /** LLM digests of issue threads agents hit, charged to the AI budget. */
  digests: z.boolean().optional(),
  /** Queue `usages` and `fleet` when a push to a default branch changes a manifest or lockfile. */
  refreshOnPush: z.boolean().optional(),
  exclude: globSchema.optional(),
  include: globSchema.optional(),
  maxVersions: z.number().int().min(1).max(50).optional(),
  firstOfMajor: z.boolean().optional(),
  sources: z
    .object({
      repository: z.boolean().optional(),
      releases: z.boolean().optional(),
      issues: z.boolean().optional(),
      site: z.boolean().optional(),
    })
    .optional(),
  graceDays: z.number().int().min(0).max(365).optional(),
  /** Libraries indexed at the same time. */
  concurrency: z.number().int().min(1).max(8).optional(),
})

/** Setting `libraries` (section `Libraries`, read at global scope): the third-party library index. */
export const librariesSetting = defineSetting({
  key: 'libraries',
  label: 'Library docs',
  description:
    'Index version-exact docs, release notes, API and issues of the third-party libraries the fleet uses, for agents and the MCP endpoint.',
  section: 'Libraries',
  help: `Holtkeeper reads the newest \`usages\` and \`fleet\` records, keeps a few versions of every npm and Go library they name (the ones in use and the ones an upgrade would land on) and indexes their docs. Only the value for **All repositories** counts; without one the index runs with the defaults below (anonymous GitHub), and \`enabled: false\` turns it off. Changing the GitHub tokens starts a new run at once.

- **interval** (default \`1d\`, at least \`1h\`): how often to look for new releases; a run also starts about two minutes after the server starts.
- **github**: leave it unset to use every credential of kind \`github\` (add one on the Credentials page and it is picked up), or list the ones to use; \`[]\` reads GitHub anonymously. They are GitHub tokens for repository docs, release notes, issues and source snapshots. Requests go to the token with the most of its limit left; tokens of the same GitHub account share one limit, so only tokens of different accounts (or GitHub Apps) add capacity. Without any GitHub is read anonymously (60 requests an hour), which is rarely enough.
- **digests**: summarize issue threads agents hit with the configured LLM, charged to the AI budget under task kind \`library-digest\`. The model is the \`library-digest\` entry of **Models per task**; without one, \`claude-haiku@latest\` when the provider lists it, else **Model**.
- **refreshOnPush** (default on): when a push to a repository's default branch changes a manifest or lockfile (\`package.json\`, \`bun.lock\`, \`pnpm-lock.yaml\`, \`go.mod\`, ...), queue \`usages\` for it and \`fleet\` for its groups, so the index learns new packages and versions minutes after the merge instead of at the weekly runs.
- **concurrency** (default 3, at most 8): libraries indexed at the same time; a run mostly waits for the network, so a few at once make it several times faster while the GitHub limit lasts.
- **exclude** / **include**: globs such as \`@types/*\` or \`Go:github.com/acme/**\`; included names are indexed even without uses.
- **sources**: \`repository\`, \`releases\` and \`issues\` are on by default, \`site\` (docs sites) is off.`,
  schema: librariesSchema,
  presets: [
    {
      id: 'on',
      label: 'On',
      description: 'Index daily with the default sources.',
      value: { enabled: true },
    },
    {
      id: 'off',
      label: 'Off',
      description: 'Index nothing.',
      value: { enabled: false },
    },
  ],
})

/** A `libraries` value with defaults applied. */
export interface LibrariesConfig {
  index: LibraryIndexSettings
  intervalMs: number
  /** Credential references of the GitHub tokens, without duplicates; every `github` credential when unset. */
  github?: string[]
  digests: boolean
  refreshOnPush: boolean
}

/** The effective config of a stored value; `undefined` when unset or invalid (nothing is indexed). */
export function librariesConfig(value: unknown): LibrariesConfig | undefined {
  const parsed = librariesSchema.safeParse(value)
  if (!parsed.success) return undefined
  const data = parsed.data
  const defaults = defaultLibraryIndexSettings
  return {
    index: {
      enabled: data.enabled ?? defaults.enabled,
      exclude: data.exclude ?? defaults.exclude,
      include: data.include ?? defaults.include,
      maxVersions: data.maxVersions ?? defaults.maxVersions,
      firstOfMajor: data.firstOfMajor ?? defaults.firstOfMajor,
      sources: { ...defaults.sources, ...data.sources },
      graceDays: data.graceDays ?? defaults.graceDays,
      concurrency: data.concurrency ?? defaults.concurrency,
    },
    intervalMs: intervalMs(data.interval ?? DEFAULT_INTERVAL) ?? 86_400_000,
    ...(data.github ? { github: [...new Set(data.github)] } : {}),
    digests: data.digests ?? false,
    refreshOnPush: data.refreshOnPush ?? true,
  }
}

/**
 * The global `libraries` value of the stored entries with defaults applied; the defaults (indexing
 * on) without an entry, `undefined` for a stored value that does not parse.
 */
export function librariesConfigFrom(entries: readonly SettingEntry[]): LibrariesConfig | undefined {
  const entry = entries
    .filter((item) => item.key === librariesSetting.key && item.scope.all === true && !item.secret)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  return librariesConfig(entry ? entry.value : {})
}

/** `librariesConfigFrom` over the setting store. */
export const librariesConfigOf = async (settings: SettingStore) =>
  librariesConfigFrom(await settings.list())

/** Whether the server indexes libraries: a store with `libraries` and the setting enabled. */
export const librariesEnabled = (config: LibrariesConfig | undefined) =>
  config?.index.enabled === true

/** A credential list and a way to reveal one secret, e.g. the credential service. */
export interface CredentialSource {
  list(): Promise<readonly { id: string; name: string; kind?: string }[]>
  reveal(id: string): Promise<string>
}

/** How long a GitHub client waits for a rate limit to reset: an index run outlasts the hourly reset. */
export type GitHubWait = 'index' | 'request'

/**
 * The GitHub client over the tokens the `github` references (credential id, else name; every
 * credential of kind `github` when `undefined`) reveal, with `ETag`s cached in `kv`; anonymous
 * without any. References that match no credential
 * or cannot be read are left out with a log line. `wait: 'index'` waits out a rate limit reset
 * (up to 65 minutes, abortable by `signal`); `'request'` waits at most 10 seconds.
 */
export async function githubClientFor(
  credentials: CredentialSource,
  references: readonly string[] | undefined,
  options: {
    log?: (line: string) => void
    kv?: Pick<KvStore, 'get' | 'set' | 'compareAndSet'>
    wait?: GitHubWait
    signal?: AbortSignal
    /** Hears the client's answers and waits besides the usage counters. */
    onEvent?: (event: GitHubEvent) => void
  } = {},
): Promise<GitHubClient> {
  const log = options.log ?? (() => {})
  const resolved = await resolveGitHubTokens(credentials, references)
  for (const credential of resolved)
    if (credential.error)
      log(
        credential.token === undefined && credential.id === credential.name
          ? `libraries: ${credential.error}; left out of the GitHub tokens`
          : `libraries: credential "${credential.name}": ${credential.error}`,
      )
  const readable = resolved.filter((credential) => credential.token !== undefined)
  if (references?.length && !readable.length)
    log('libraries: no GitHub token could be read; reading GitHub anonymously')
  const usage = githubUsageFor(options.kv)
  return createGitHubClient({
    tokens: readable.map((credential) => credential.token!),
    maxWaitMs: options.wait === 'index' && readable.length ? 65 * 60_000 : 10_000,
    ...(options.kv ? { cache: options.kv } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    log,
    onEvent: (event) => {
      usage.record(
        event,
        event.kind === 'request' && event.token !== undefined
          ? readable[event.token]?.id
          : undefined,
      )
      options.onEvent?.(event)
    },
  })
}

/** Third-party libraries the fleet uses, and the ones it defines itself. */
export interface FleetLibraryUses {
  uses: LibraryUse[]
  /** `<ecosystem>:<name>` of libraries defined in the fleet: `fleet`'s `definedIn` and the API catalog's packages. */
  internal: Set<string>
}

const exactVersion = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/

/**
 * Uses from the newest `usages` record of every repository (npm, exact resolved versions, local
 * workspaces left out) and the newest `fleet` record of every group (npm and Go, the resolved
 * version, else the one compared with the latest).
 */
export async function fleetLibraryUses(analyses: AnalysisStore): Promise<FleetLibraryUses> {
  const uses = new Map<string, LibraryUse>()
  const internal = new Set<string>()
  const add = (ecosystem: LibraryEcosystem, name: string, version: string, repo: string) => {
    if (!exactVersion.test(version)) return
    const key = `${ecosystem}\u0000${name}\u0000${version}\u0000${repo}`
    if (!uses.has(key)) uses.set(key, { ecosystem, name, version, repo })
  }

  for (const record of await createUsageIndex({ analyses }).records(() => true)) {
    const repo = `${record.repo.forge}:${record.repo.path}`
    for (const pkg of record.data.packages) {
      if (pkg.local) {
        internal.add(`npm:${pkg.name}`)
        continue
      }
      if (pkg.name.startsWith('node:')) continue
      for (const version of pkg.versions) add('npm', pkg.name, version, repo)
    }
  }

  const fleets = await newestRecords(
    analyses,
    'fleet',
    (record) => fleetDataSchema.safeParse(record.data).data,
  )
  for (const { record, value } of fleets.values()) {
    for (const library of value.libraries) {
      if (library.definedIn) {
        internal.add(`${library.ecosystem}:${library.name}`)
        continue
      }
      for (const usage of library.usages) {
        const version = usage.resolved ?? usage.version
        if (version)
          add(library.ecosystem, library.name, version, `${record.repo.forge}:${usage.repo}`)
      }
    }
  }

  for (const pkg of await createApiCatalog({ analyses }).packages(() => true))
    internal.add(`npm:${pkg.name}`)

  return { uses: [...uses.values()], internal }
}

/** The last finished indexing run, from `store.kv`. */
export async function lastLibraryRun(
  kv: KvStore | undefined,
): Promise<LibraryIndexRun | undefined> {
  const value = await kv?.get(LAST_RUN_KEY)
  return typeof value === 'object' && value !== null && 'startedAt' in value
    ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by `runLibraryIndex`
      (value as LibraryIndexRun)
    : undefined
}

/**
 * Asks the leader for a run, from any process sharing the store: `false` when one is going. The
 * leader picks the request up within its poll interval.
 */
export async function requestLibraryIndex(kv: KvStore): Promise<boolean> {
  if (await kv.get(RUNNING_KEY)) return false
  await kv.set(REQUEST_KEY, true, 86_400)
  return true
}

const requestedAfter = (value: unknown) =>
  typeof value === 'object' && value !== null && 'after' in value && typeof value.after === 'string'
    ? value.after
    : undefined

/**
 * Notes that an analysis record landed: a new `usages` or `fleet` record asks for a run 10
 * minutes later, each further one moving it again, so a batch of jobs leads to one run. Explicit
 * requests (`requestLibraryIndex`) stay immediate. Other kinds are ignored.
 */
export async function noteLibraryUses(
  kv: KvStore | undefined,
  kind: string,
  now: Date,
  debounceMs = CHANGE_DEBOUNCE_MS,
): Promise<void> {
  if (!kv || !USE_KINDS.has(kind)) return
  if ((await kv.get(REQUEST_KEY)) === true) return
  await kv.set(REQUEST_KEY, { after: new Date(now.getTime() + debounceMs).toISOString() }, 86_400)
}

/** Whether a stored request is due at `now`: an explicit one, or a debounced one whose time came. */
const requestDue = (value: unknown, now: Date) => {
  if (value === true) return true
  const after = requestedAfter(value)
  return after !== undefined && Date.parse(after) <= now.getTime()
}

/** What an indexing run needs besides the store. */
export interface LibraryIndexDeps {
  store: {
    libraries?: LibraryStore
    analyses: AnalysisStore
    settings: SettingStore
    kv?: KvStore
  }
  artifacts?: ArtifactStore
  credentials: CredentialSource
  now: () => Date
}

/** Seams of the index duty; defaults reach the real registries and GitHub. */
export interface LibraryIndexOptions {
  registries?: Partial<Record<LibraryEcosystem, LibraryRegistry>>
  /** Replaces the client from the `github` credential. */
  github?: GitHubClient
  /** Delay of the first run. Default 2 min. */
  startDelayMs?: number
  /** How often the leader looks for requests and due runs. Default 30 s. */
  pollMs?: number
  signal?: AbortSignal
}

/**
 * One indexing run with the current `libraries` setting: uses from `usages` and `fleet` records,
 * npm and Go registries, GitHub from the setting's credential. Records the run in `store.kv`
 * (`libraries:last-run`) and returns it; `undefined` when indexing is off or impossible.
 */
export async function runLibraryIndex(
  deps: LibraryIndexDeps,
  options: LibraryIndexOptions = {},
  log: (line: string) => void = () => {},
): Promise<LibraryIndexRun | undefined> {
  const { store, artifacts } = deps
  const libraries = store.libraries
  const config = await librariesConfigOf(store.settings)
  if (!libraries || !artifacts || !config || !librariesEnabled(config)) return undefined
  const startedAt = deps.now().toISOString()
  const base = {
    startedAt,
    libraries: 0,
    versionsAdded: 0,
    versionsRemoved: 0,
    librariesRemoved: 0,
    failures: [],
  }
  let run: LibraryIndexRun
  const progress = libraryProgressWriter({ kv: store.kv, now: deps.now })
  try {
    const { uses, internal } = await fleetLibraryUses(store.analyses)
    const github =
      options.github ??
      (await githubClientFor(deps.credentials, config.github, {
        log,
        wait: 'index',
        ...(store.kv ? { kv: store.kv } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        onEvent: (event) => {
          if (event.kind === 'wait') progress.waiting(new Date(deps.now().getTime() + event.ms))
        },
      }))
    const summary = await indexLibraries({
      store: libraries,
      artifacts,
      registries: options.registries ?? { npm: npmRegistry(), Go: goRegistry() },
      github,
      uses,
      settings: config.index,
      isInternal: (ref) => internal.has(`${ref.ecosystem}:${ref.name}`),
      ...(config.index.sources.site ? { siteSource: siteSource() } : {}),
      now: deps.now,
      ...(options.signal ? { signal: options.signal } : {}),
      log,
      onProgress: (state) => progress.update(state),
    })
    run = {
      ...base,
      finishedAt: deps.now().toISOString(),
      libraries: summary.libraries,
      versionsAdded: summary.versionsAdded,
      versionsRemoved: summary.versionsRemoved,
      librariesRemoved: summary.librariesRemoved,
      failures: summary.failures.slice(0, MAX_STORED_FAILURES),
    }
  } catch (error) {
    if (options.signal?.aborted) {
      await progress.clear()
      throw error
    }
    run = {
      ...base,
      finishedAt: deps.now().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
  await progress.clear()
  await store.kv?.set(LAST_RUN_KEY, run)
  log(
    run.error
      ? `libraries: run failed: ${run.error}`
      : `libraries: ${run.libraries} indexed, ${run.versionsAdded} versions added, ${run.versionsRemoved} removed, ${run.librariesRemoved} libraries removed, ${run.failures.length} failures`,
  )
  return run
}

/**
 * Leader duty: about two minutes after start, then whenever the setting's `interval` passed since
 * the last run or `requestLibraryIndex` asked, runs `runLibraryIndex`, one run at a time. Does
 * nothing on stores without `libraries` or without an artifact store; the setting is reread on
 * every poll, so turning it on needs no restart. Stopping aborts a running run.
 */
export function startLibraryIndex(
  deps: LibraryIndexDeps,
  log: (line: string) => void,
  options: LibraryIndexOptions = {},
): () => Promise<void> {
  const { kv } = deps.store
  if (!deps.store.libraries || !deps.artifacts) return async () => {}
  const controller = new AbortController()
  let running: Promise<unknown> | undefined
  let run: AbortController | undefined
  let runTokens: string | undefined
  let started = false
  let lastStartedAt = 0

  const due = async (config: LibrariesConfig) => {
    const everyMs = config.intervalMs
    if (!started || requestDue(await kv?.get(REQUEST_KEY), deps.now())) return true
    const used = await kv?.get(TOKENS_KEY)
    if (used !== undefined && used !== (await tokensOf(deps.credentials, config))) return true
    const last = await lastLibraryRun(kv)
    const lastAt = Math.max(lastStartedAt, last ? Date.parse(last.startedAt) : 0)
    return deps.now().getTime() - lastAt >= everyMs
  }

  const tick = () => {
    if (running) {
      void kv?.set(RUNNING_KEY, true, RUNNING_TTL_S)
      void (async () => {
        const config = await librariesConfigOf(deps.store.settings)
        if (
          run &&
          config &&
          runTokens !== undefined &&
          (await tokensOf(deps.credentials, config)) !== runTokens
        ) {
          log('libraries: GitHub tokens changed; restarting the index run with them')
          run.abort()
        }
      })().catch(() => {})
      return
    }
    running = (async () => {
      const config = await librariesConfigOf(deps.store.settings)
      if (!config || !librariesEnabled(config)) {
        await kv?.delete(REQUEST_KEY)
        return
      }
      if (!(await due(config))) return
      started = true
      lastStartedAt = deps.now().getTime()
      runTokens = await tokensOf(deps.credentials, config)
      run = new AbortController()
      await kv?.delete(REQUEST_KEY)
      await kv?.set(TOKENS_KEY, runTokens)
      await kv?.set(RUNNING_KEY, true, RUNNING_TTL_S)
      try {
        await runLibraryIndex(
          deps,
          { ...options, signal: AbortSignal.any([controller.signal, run.signal]) },
          log,
        )
      } finally {
        await kv?.delete(RUNNING_KEY)
      }
    })()
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !run?.signal.aborted)
          log(`libraries: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        running = undefined
      })
  }

  const pollMs = options.pollMs ?? 30_000
  let poller: ReturnType<typeof setInterval> | undefined
  const first = setTimeout(() => {
    tick()
    poller = setInterval(tick, pollMs)
  }, options.startDelayMs ?? 120_000)
  return async () => {
    clearTimeout(first)
    if (poller) clearInterval(poller)
    controller.abort()
    await running
  }
}

/** A `Summarize` over an agent: one turn without tools in an empty folder, task kind `library-digest`. */
export function agentSummarize(agent: Agent): Summarize {
  return async (prompt, signal) => {
    const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-digest-'))
    try {
      const result = await agent.run({
        dir,
        prompt,
        capabilities: [],
        maxTurns: 1,
        taskKind: 'library-digest',
        ...(signal ? { signal } : {}),
      })
      return result.text
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

/** Inputs of `serverLibraryDocs`. */
export interface ServerLibraryDocsOptions {
  libraries: LibraryStore
  artifacts: ArtifactStore
  /** Caches live issue searches. */
  kv?: KvStore
  /** The GitHub client for live issue search and source snapshots; resolved once, on first use. */
  github: () => Promise<GitHubClient>
  /** The model for issue digests of a caller repository; `undefined` leaves digests off. */
  summarize?: (repo: string | undefined) => Promise<Summarize | undefined>
}

/**
 * `libraryDocs` for the MCP endpoint and agents: issue search with live GitHub search (cached in
 * `kv`) and optional digests, and source snapshots made on demand.
 */
export function serverLibraryDocs(options: ServerLibraryDocsOptions): LibraryDocs {
  const { libraries: store, artifacts } = options
  let client: Promise<GitHubClient> | undefined
  const github = () => (client ??= options.github())
  let snapshots: ReturnType<typeof sourceSnapshots> | undefined
  return libraryDocs({
    store,
    artifacts,
    async issues(input, caller) {
      const summarize = await options.summarize?.(caller?.repo)
      return libraryIssues({
        store,
        live: liveIssueSearch({
          github: await github(),
          ...(options.kv ? { cache: options.kv } : {}),
        }),
        ...(summarize ? { digest: digestOnDemand({ store, summarize }) } : {}),
      })(input, caller)
    },
    async source(ref, version) {
      snapshots ??= sourceSnapshots({ store, artifacts, github: await github() })
      return snapshots(ref, version)
    },
  })
}

/**
 * Who may see which library: a library is visible when some repository the caller may read uses
 * it, and libraries no repository uses are visible to callers with global read access. Shared by
 * the `/api/libraries` routes and the MCP tools.
 */
export interface LibraryReader {
  /** Whether the caller may read a repository, as `forge:path`. */
  canRead: (repo: string) => boolean
  /** The readable users of a library's versions and whether the library is visible. */
  view: (versions: readonly LibraryVersionRecord[]) => { visible: boolean; readable: string[] }
}

/** A `LibraryReader` over a repository check and whether the caller reads everything. */
export function libraryReader(options: {
  canRead: (repo: { forge: string; path: string }) => boolean
  global: boolean
}): LibraryReader {
  const cache = new Map<string, boolean>()
  const canRead = (key: string) => {
    const known = cache.get(key)
    if (known !== undefined) return known
    const separator = key.indexOf(':')
    const result =
      separator > 0 &&
      options.canRead({ forge: key.slice(0, separator), path: key.slice(separator + 1) })
    cache.set(key, result)
    return result
  }
  return {
    canRead,
    view: (versions) => {
      const all = new Set(versions.flatMap((version) => version.usedBy))
      const readable = [...all].filter(canRead)
      return { visible: readable.length > 0 || (all.size === 0 && options.global), readable }
    },
  }
}

/**
 * `store` as `reader`'s caller sees it: libraries they may not see do not exist for reads
 * (records, versions, chunks, issues, stats). Records keep their full `usedBy`, so writes that
 * pass a read record back (source snapshots) lose nothing; answers filter it themselves.
 */
export function visibleLibraries(store: LibraryStore, reader: LibraryReader): LibraryStore {
  const known = new Map<string, Promise<boolean>>()
  const visible = (ref: LibraryRef) => {
    const key = `${ref.ecosystem}:${ref.name}`
    let result = known.get(key)
    if (!result) {
      result = store.listVersions(ref).then((versions) => reader.view(versions).visible)
      known.set(key, result)
    }
    return result
  }
  const keep = async <T>(items: T[], refOf: (item: T) => LibraryRef) => {
    const flags = await Promise.all(items.map(async (item) => visible(refOf(item))))
    return items.filter((_, index) => flags[index])
  }
  return {
    ...store,
    async getLibrary(ref) {
      return (await visible(ref)) ? store.getLibrary(ref) : undefined
    },
    async listLibraries(filter) {
      return keep(await store.listLibraries(filter), (record) => record)
    },
    async getVersion(ref, version) {
      return (await visible(ref)) ? store.getVersion(ref, version) : undefined
    },
    async listVersions(ref) {
      return (await visible(ref)) ? store.listVersions(ref) : []
    },
    async listChunks(filter, limit) {
      return keep(await store.listChunks(filter, limit), (chunk) => chunk)
    },
    async searchChunks(text, filter, limit = 20) {
      const hits = await keep(await store.searchChunks(text, filter, limit * 3), (hit) => hit.chunk)
      return hits.slice(0, limit)
    },
    async getIssue(id) {
      const issue = await store.getIssue(id)
      return issue && (await visible(issue)) ? issue : undefined
    },
    async searchIssues(text, filter, limit = 20) {
      const hits = await keep(await store.searchIssues(text, filter, limit * 3), (hit) => hit.issue)
      return hits.slice(0, limit)
    },
    async libraryStats(filter) {
      const stats = await store.libraryStats(filter)
      for (const key of stats.keys()) {
        const separator = key.indexOf(':')
        const ecosystem = key.slice(0, separator)
        // oxlint-disable-next-line no-await-in-loop -- visibility is cached per library
        if (
          !(await visible({
            ecosystem: ecosystem === 'Go' ? 'Go' : 'npm',
            name: key.slice(separator + 1),
          }))
        )
          stats.delete(key)
      }
      return stats
    },
  }
}
