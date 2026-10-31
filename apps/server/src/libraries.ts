import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Agent } from '@holtkeeper/agent'
import type { LibraryIndexRun } from '@holtkeeper/api'
import type { ArtifactStore } from '@holtkeeper/artifacts'
import { fleetDataSchema } from '@holtkeeper/fleet'
import {
  type GitHubClient,
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
import { intervalMs } from '@holtkeeper/updates'
import { z } from 'zod'

import { createApiCatalog } from './api-surface/catalog.ts'
import { createUsageIndex } from './api-surface/usages.ts'

const intervalPattern = /^([1-9]\d*)(m|h|d)$/
const MIN_INTERVAL_MS = 3_600_000
const DEFAULT_INTERVAL = '1d'
const LAST_RUN_KEY = 'libraries:last-run'
const REQUEST_KEY = 'libraries:reindex'
const RUNNING_KEY = 'libraries:running'
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
  /** Id or name of a credential whose secret is a GitHub token. */
  github: z.string().trim().min(1).meta({ 'x-credential': 'github' }).optional(),
  /** LLM digests of issue threads agents hit, charged to the AI budget. */
  digests: z.boolean().optional(),
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
})

/** Setting `libraries` (section `Libraries`, read at global scope): the third-party library index. */
export const librariesSetting = defineSetting({
  key: 'libraries',
  label: 'Library docs',
  description:
    'Index version-exact docs, release notes, API and issues of the third-party libraries the fleet uses, for agents and the MCP endpoint.',
  section: 'Libraries',
  help: `Holtkeeper reads the newest \`usages\` and \`fleet\` records, keeps a few versions of every npm and Go library they name (the ones in use and the ones an upgrade would land on) and indexes their docs. Only the value for **All repositories** counts; without one nothing is indexed.

- **interval** (default \`1d\`, at least \`1h\`): how often to look for new releases; a run also starts about two minutes after the server starts.
- **github**: a credential whose secret is a GitHub token, for repository docs, release notes, issues and source snapshots. Without it GitHub is read anonymously (60 requests an hour), which is rarely enough.
- **digests**: summarize issue threads agents hit with the configured LLM, charged to the AI budget under task kind \`library-digest\`.
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
  github?: string
  digests: boolean
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
    },
    intervalMs: intervalMs(data.interval ?? DEFAULT_INTERVAL) ?? 86_400_000,
    ...(data.github ? { github: data.github } : {}),
    digests: data.digests ?? false,
  }
}

/** The global `libraries` value of the stored entries, with defaults applied. */
export function librariesConfigFrom(entries: readonly SettingEntry[]): LibrariesConfig | undefined {
  const entry = entries
    .filter((item) => item.key === librariesSetting.key && item.scope.all === true && !item.secret)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  return entry ? librariesConfig(entry.value) : undefined
}

/** `librariesConfigFrom` over the setting store. */
export const librariesConfigOf = async (settings: SettingStore) =>
  librariesConfigFrom(await settings.list())

/** Whether the server indexes libraries: a store with `libraries` and the setting enabled. */
export const librariesEnabled = (config: LibrariesConfig | undefined) =>
  config?.index.enabled === true

/** A credential list and a way to reveal one secret, e.g. the credential service. */
export interface CredentialSource {
  list(): Promise<readonly { id: string; name: string }[]>
  reveal(id: string): Promise<string>
}

/**
 * The GitHub client the `github` reference (credential id, else name) authenticates; anonymous
 * without a reference, and anonymous with a log line when the credential is missing or unreadable.
 */
export async function githubClientFor(
  credentials: CredentialSource,
  reference: string | undefined,
  log: (line: string) => void = () => {},
): Promise<GitHubClient> {
  if (!reference) return createGitHubClient()
  const all = await credentials.list()
  const credential =
    all.find((item) => item.id === reference) ?? all.find((item) => item.name === reference)
  if (!credential) {
    log(`libraries: no credential "${reference}"; reading GitHub anonymously`)
    return createGitHubClient()
  }
  try {
    return createGitHubClient({ token: await credentials.reveal(credential.id) })
  } catch (error) {
    log(
      `libraries: credential "${credential.name}": ${error instanceof Error ? error.message : String(error)}`,
    )
    return createGitHubClient()
  }
}

const PAGE = 50
const MAX_FLEET_RECORDS = 1000

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

  const groups = new Set<string>()
  let before: string | undefined
  for (let seen = 0; seen < MAX_FLEET_RECORDS; seen += PAGE) {
    // oxlint-disable-next-line no-await-in-loop -- pages depend on the previous one
    const page = await analyses.list({ kind: 'fleet', limit: PAGE, ...(before ? { before } : {}) })
    for (const record of page) {
      const group = `${record.repo.forge}:${record.repo.path}`
      if (groups.has(group)) continue
      const parsed = fleetDataSchema.safeParse(record.data)
      if (!parsed.success) continue
      groups.add(group)
      for (const library of parsed.data.libraries) {
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
    if (page.length < PAGE) break
    before = page.at(-1)?.createdAt
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
  try {
    const { uses, internal } = await fleetLibraryUses(store.analyses)
    const github = options.github ?? (await githubClientFor(deps.credentials, config.github, log))
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
    if (options.signal?.aborted) throw error
    run = {
      ...base,
      finishedAt: deps.now().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
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
  let started = false
  let lastStartedAt = 0

  const due = async (everyMs: number) => {
    if (!started || requestDue(await kv?.get(REQUEST_KEY), deps.now())) return true
    const last = await lastLibraryRun(kv)
    const lastAt = Math.max(lastStartedAt, last ? Date.parse(last.startedAt) : 0)
    return deps.now().getTime() - lastAt >= everyMs
  }

  const tick = () => {
    if (running) {
      void kv?.set(RUNNING_KEY, true, RUNNING_TTL_S)
      return
    }
    running = (async () => {
      const config = await librariesConfigOf(deps.store.settings)
      if (!config || !librariesEnabled(config)) {
        await kv?.delete(REQUEST_KEY)
        return
      }
      if (!(await due(config.intervalMs))) return
      started = true
      lastStartedAt = deps.now().getTime()
      await kv?.delete(REQUEST_KEY)
      await kv?.set(RUNNING_KEY, true, RUNNING_TTL_S)
      try {
        await runLibraryIndex(deps, { ...options, signal: controller.signal }, log)
      } finally {
        await kv?.delete(RUNNING_KEY)
      }
    })()
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
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
