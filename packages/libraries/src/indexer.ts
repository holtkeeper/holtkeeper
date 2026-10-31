import type { ArtifactStore } from '@holtkeeper/artifacts'
import type {
  LibraryEcosystem,
  LibraryRecord,
  LibraryRef,
  LibrarySourceKind,
  LibrarySourceStatus,
  LibraryStore,
  LibraryVersionRecord,
} from '@holtkeeper/store'

import type { GitHubClient } from './github/client.ts'
import { libraryOfModule } from './go/module.ts'
import { indexIssues } from './issues/index-issues.ts'
import { versionMatrix } from './matrix.ts'
import { compareSemver, majorOf } from './semver.ts'
import { type ApiExtractor, apiSource, defaultApiExtractors } from './sources/api.ts'
import { archiveSource } from './sources/archive.ts'
import { assignReleases, listReleases, releaseChunks } from './sources/releases.ts'
import { repositorySource } from './sources/repository.ts'
import { type SourceOutcome, errorText, libraryKey, refOf, sourceStatus } from './sources/shared.ts'
import type { SiteSource } from './sources/site.ts'
import { type TagResolver, githubPath, tagResolver } from './tags.ts'
import type {
  ArchiveFiles,
  LibraryIndexSettings,
  LibraryRegistry,
  LibraryUse,
  PublishedLibrary,
} from './types.ts'

/** What library hooks get besides the library: its indexed versions and the run's context. */
export interface LibraryHookContext {
  /** Versions in the matrix, highest first. */
  versions: LibraryVersionRecord[]
  /** Publication date of the oldest used version, when the registry has it. */
  oldestUsedReleaseAt?: string
  now: Date
  signal?: AbortSignal
}

/**
 * A library-wide source run by the indexer after the per-version ones (issues, docs site). It
 * records its own `LibraryRecord.sources` status; when it throws, the indexer records `failed`.
 */
export type LibraryHook = (library: LibraryRecord, context: LibraryHookContext) => Promise<unknown>

/** Inputs of `indexLibraries`. */
export interface IndexLibrariesOptions {
  store: LibraryStore
  artifacts: ArtifactStore
  registries: Partial<Record<LibraryEcosystem, LibraryRegistry>>
  /** Without it, repository, releases and hook sources that need GitHub are `skipped`. */
  github?: GitHubClient
  /** Every repository's resolved versions of third-party libraries. */
  uses: readonly LibraryUse[]
  settings: LibraryIndexSettings
  /** Libraries the fleet defines itself; left to `api-surface`. */
  isInternal?: (ref: LibraryRef) => boolean
  /** API readers per ecosystem. Default `defaultApiExtractors` (npm declarations, Go sources). */
  apiExtractors?: Partial<Record<LibraryEcosystem, ApiExtractor>>
  /**
   * Runs when `settings.sources.issues` is on. Default with `github`: `indexIssues` of
   * `src/issues/`; without `github` issues are not indexed.
   */
  issueIndexer?: LibraryHook
  /**
   * Runs when `settings.sources.site` is on; its chunks go to the latest version and to the
   * highest used version when that is of another major.
   */
  siteSource?: SiteSource
  /** Repositories larger than this (GitHub's `size`, in KB) get no `repository` source. Default 500 MB. */
  maxRepositoryKb?: number
  now?: () => Date
  signal?: AbortSignal
  log?: (line: string) => void
  /** Told before each library and once when every library is done, e.g. to show how far a run is. */
  onProgress?: (progress: LibraryIndexProgress) => void
}

/**
 * How far a run is: `done` of `total` libraries, and the ones it works on (`<ecosystem>:<name>`)
 * in the order it took them; `library` is the first of them.
 */
export interface LibraryIndexProgress {
  total: number
  done: number
  library?: string
  libraries?: string[]
}

/** A source that failed for one library or version. */
export interface LibraryIndexFailure {
  /** `<ecosystem>:<name>`. */
  library: string
  version?: string
  source: LibrarySourceKind
  message: string
}

/** What one `indexLibraries` run did. */
export interface LibraryIndexSummary {
  /** Libraries indexed in this run. */
  libraries: number
  versionsAdded: number
  versionsRemoved: number
  librariesRemoved: number
  failures: LibraryIndexFailure[]
}

const done = (status: LibrarySourceStatus | undefined) =>
  status?.status === 'ok' || status?.status === 'missing'

const hasGlob = (pattern: string) => /[*?[\]{}!]/.test(pattern)

/** `npm:name`, `Go:path` or a bare name (Go when its first segment has a dot, else npm). */
export function parseLibraryName(text: string): LibraryRef {
  const prefixed = /^(npm|go):(.+)$/i.exec(text)
  if (prefixed?.[1] && prefixed[2])
    return { ecosystem: prefixed[1].toLowerCase() === 'go' ? 'Go' : 'npm', name: prefixed[2] }
  const first = text.split('/')[0] ?? ''
  return { ecosystem: !text.startsWith('@') && first.includes('.') ? 'Go' : 'npm', name: text }
}

const matcher = (patterns: readonly string[]) => {
  const globs = patterns.map((pattern) => {
    const ref = parseLibraryName(pattern)
    const prefixed = /^(npm|go):/i.test(pattern)
    return { ecosystem: prefixed ? ref.ecosystem : undefined, glob: new Bun.Glob(ref.name) }
  })
  return (ref: LibraryRef) =>
    globs.some(
      ({ ecosystem, glob }) => (!ecosystem || ecosystem === ref.ecosystem) && glob.match(ref.name),
    )
}

/**
 * Indexes the libraries `uses` names, `settings.concurrency` of them at a time; each gets registry
 * metadata, the version matrix, then every source a matrix version lacks (`archive`, `api`, and
 * with GitHub `repository` and `releases`), then the issue and site hooks. Sources that ended `ok` or
 * `missing` are not fetched again; a failure is recorded on its source and in the summary and
 * never stops the run. Versions that left the matrix keep their data for `graceDays` and are then
 * removed; so are libraries no repository uses any more. Artifacts of kept versions are read
 * once per run so time-based artifact retention does not drop them, and are fetched again when
 * they are gone. Rejects only when `signal` aborts.
 */
export async function indexLibraries(options: IndexLibrariesOptions): Promise<LibraryIndexSummary> {
  const { store, settings } = options
  const now = options.now ?? (() => new Date())
  const summary: LibraryIndexSummary = {
    libraries: 0,
    versionsAdded: 0,
    versionsRemoved: 0,
    librariesRemoved: 0,
    failures: [],
  }
  if (!settings.enabled) return summary

  const excluded = matcher(settings.exclude)
  const included = matcher(settings.include)
  const groups = new Map<string, { ref: LibraryRef; uses: LibraryUse[] }>()
  const group = (ref: LibraryRef) => {
    const key = libraryKey(ref)
    let value = groups.get(key)
    if (!value) groups.set(key, (value = { ref: refOf(ref), uses: [] }))
    return value
  }
  for (const raw of options.uses) {
    const use = raw.ecosystem === 'Go' ? { ...raw, name: libraryOfModule(raw.name) } : raw
    if (options.isInternal?.(use) || options.isInternal?.(raw)) continue
    if (excluded(use) && !included(use)) continue
    group(use).uses.push(use)
  }
  for (const pattern of settings.include) {
    if (hasGlob(pattern)) continue
    const ref = parseLibraryName(pattern)
    if (!options.isInternal?.(ref)) group(ref)
  }

  const resolveTag = options.github ? tagResolver(options.github) : undefined
  const github = options.github
  const issueIndexer =
    options.issueIndexer ??
    (github
      ? async (library: LibraryRecord, context: LibraryHookContext) =>
          indexIssues({
            store,
            github,
            library,
            now: context.now,
            ...(context.oldestUsedReleaseAt
              ? { oldestUsedReleaseAt: context.oldestUsedReleaseAt }
              : {}),
            ...(context.signal ? { signal: context.signal } : {}),
            ...(options.log ? { log: options.log } : {}),
          })
      : undefined)
  const run: RunContext = {
    ...options,
    ...(issueIndexer ? { issueIndexer } : {}),
    now,
    summary,
    resolveTag,
    repositoryKb: new Map(),
  }
  const keys = [...groups.keys()].toSorted()
  const active: string[] = []
  let next = 0
  let finished = 0
  let failure: { error: unknown } | undefined
  const report = () =>
    options.onProgress?.({
      total: keys.length,
      done: finished,
      ...(active[0] ? { library: active[0], libraries: [...active] } : {}),
    })
  const worker = async () => {
    while (!failure && next < keys.length) {
      options.signal?.throwIfAborted()
      const entry = groups.get(keys[next++] ?? '')
      if (!entry) {
        finished += 1
        continue
      }
      const name = libraryKey(entry.ref)
      active.push(name)
      report()
      try {
        // oxlint-disable-next-line no-await-in-loop -- each worker takes one library after another
        await indexLibrary(run, entry.ref, entry.uses)
        summary.libraries += 1
      } catch (error) {
        failure ??= { error }
      } finally {
        active.splice(active.indexOf(name), 1)
        finished += 1
      }
    }
  }
  const workers = Math.max(1, Math.min(settings.concurrency ?? 1, keys.length || 1))
  await Promise.all(Array.from({ length: workers }, worker))
  options.signal?.throwIfAborted()
  if (failure) throw failure.error
  report()
  await dropUnused(run, new Set(groups.keys()))
  return summary
}

interface RunContext extends IndexLibrariesOptions {
  now: () => Date
  summary: LibraryIndexSummary
  resolveTag: TagResolver | undefined
  repositoryKb: Map<string, Promise<number | undefined>>
}

const fail = (
  run: RunContext,
  ref: LibraryRef,
  source: LibrarySourceKind,
  error: unknown,
  version?: string,
) => {
  const message = errorText(error)
  run.summary.failures.push({
    library: libraryKey(ref),
    ...(version ? { version } : {}),
    source,
    message,
  })
  run.log?.(`libraries: ${libraryKey(ref)}${version ? `@${version}` : ''} ${source}: ${message}`)
  return sourceStatus('failed', run.now, message)
}

const elapsedDays = (since: string | undefined, now: Date) =>
  since ? (now.getTime() - Date.parse(since)) / 86_400_000 : 0

async function indexLibrary(run: RunContext, ref: LibraryRef, uses: LibraryUse[]): Promise<void> {
  const { store } = run
  const at = run.now().toISOString()
  const previous = await store.getLibrary(ref)
  const registry = run.registries[ref.ecosystem]
  let published: PublishedLibrary | undefined
  let registryStatus: LibrarySourceStatus
  if (!registry) registryStatus = sourceStatus('skipped', run.now, `no ${ref.ecosystem} registry`)
  else {
    try {
      published = await registry.library(ref)
      if (!published) {
        if (previous) {
          await store.removeLibrary(ref)
          run.summary.librariesRemoved += 1
        }
        return
      }
      registryStatus = sourceStatus('ok', run.now)
    } catch (error) {
      registryStatus = fail(run, ref, 'registry', error)
      await store.putLibrary({
        ...(previous ?? { ...ref }),
        sources: { ...previous?.sources, registry: registryStatus },
        updatedAt: at,
      })
      return
    }
  }

  const matrix = versionMatrix(uses, published, run.settings)
  const latest = matrix.find((item) => item.roles.includes('latest'))?.version ?? published?.latest
  const library: LibraryRecord = {
    ...previous,
    ...ref,
    ...(published?.description ? { description: published.description } : {}),
    ...(published?.homepage ? { homepage: published.homepage } : {}),
    ...(published?.repository ? { repository: published.repository } : {}),
    ...(latest ? { latest } : {}),
    sources: { ...previous?.sources, registry: registryStatus },
    updatedAt: at,
  }
  await store.putLibrary(library)

  const existing = new Map(
    (await store.listVersions(ref)).map((record) => [record.version, record]),
  )
  const releasesOf = new Map(published?.versions.map((item) => [item.version, item]))
  let matrixChanged = false
  const current: LibraryVersionRecord[] = []
  for (const item of matrix) {
    const before = existing.get(item.version)
    const info = releasesOf.get(item.version)
    const { leftAt: _left, ...kept } = before ?? { sources: {} }
    if (!before || !before.roles.length) matrixChanged = true
    if (!before) run.summary.versionsAdded += 1
    const commit = before?.commit ?? info?.commit
    const record: LibraryVersionRecord = {
      ...kept,
      ...ref,
      version: item.version,
      roles: item.roles,
      usedBy: item.usedBy,
      ...(info?.publishedAt ? { publishedAt: info.publishedAt } : {}),
      ...(info?.deprecated ? { deprecated: info.deprecated } : {}),
      ...(commit ? { commit } : {}),
      sources: before?.sources ?? {},
      updatedAt: at,
    }
    if (before?.deprecated && !info?.deprecated && info) delete record.deprecated
    await store.putVersion(record)
    current.push(record)
  }
  const inMatrix = new Set(matrix.map((item) => item.version))
  for (const record of existing.values()) {
    if (inMatrix.has(record.version)) continue
    if (record.roles.length) matrixChanged = true
    const leftAt = record.leftAt ?? at
    if (elapsedDays(leftAt, run.now()) >= run.settings.graceDays) {
      await store.removeVersion(ref, record.version)
      run.summary.versionsRemoved += 1
      matrixChanged = true
      continue
    }
    if (record.leftAt && !record.roles.length && !record.usedBy.length) continue
    await store.putVersion({ ...record, roles: [], usedBy: [], leftAt, updatedAt: at })
  }

  for (const [index, record] of current.entries()) {
    run.signal?.throwIfAborted()
    current[index] = await indexVersion(run, library, record)
  }
  if (run.settings.sources.releases) await indexReleases(run, library, current, matrixChanged)
  await runHooks(run, library, current)
}

async function keepArtifacts(
  run: RunContext,
  record: LibraryVersionRecord,
): Promise<LibraryVersionRecord> {
  const next = { ...record, sources: { ...record.sources } }
  const check = async (id: string | undefined) => {
    if (!id) return true
    const opened = await run.artifacts.open(id)
    if (!opened) return false
    await opened.body.cancel()
    return true
  }
  if (!(await check(record.api))) {
    delete next.api
    delete next.sources.api
  }
  if (!(await check(record.sourceArchive))) {
    delete next.sourceArchive
    delete next.sources.source
  }
  return next
}

async function indexVersion(
  run: RunContext,
  library: LibraryRecord,
  initial: LibraryVersionRecord,
): Promise<LibraryVersionRecord> {
  const ref = refOf(library)
  const version = initial.version
  let record = await keepArtifacts(run, initial)
  const target = () => ({ library, version: record, now: run.now })
  const apply = async (source: LibrarySourceKind, outcome: SourceOutcome) => {
    record = {
      ...record,
      ...outcome.patch,
      sources: { ...record.sources, [source]: outcome.status },
      updatedAt: run.now().toISOString(),
    }
    await run.store.putVersion(record)
  }
  const attempt = async (source: LibrarySourceKind, work: () => Promise<SourceOutcome>) => {
    try {
      await apply(source, await work())
    } catch (error) {
      run.signal?.throwIfAborted()
      await apply(source, { status: fail(run, ref, source, error, version) })
    }
  }

  if (!done(record.sources.archive) || !done(record.sources.api)) {
    const registry = run.registries[library.ecosystem]
    let files: ArchiveFiles | undefined
    let fetched = false
    try {
      files = await registry?.archive(ref, version)
      fetched = registry !== undefined
    } catch (error) {
      run.signal?.throwIfAborted()
      const status = fail(run, ref, 'archive', error, version)
      await apply('archive', { status })
      if (!done(record.sources.api)) await apply('api', { status })
    }
    if (fetched) {
      if (!done(record.sources.archive))
        await attempt('archive', () => archiveSource(run.store, target(), files))
      if (!done(record.sources.api)) {
        const extractor = (run.apiExtractors ?? defaultApiExtractors)[library.ecosystem]
        await attempt('api', () => apiSource(run.artifacts, target(), files, extractor))
      }
    } else if (!registry) {
      const status = sourceStatus('skipped', run.now, `no ${library.ecosystem} registry`)
      await apply('archive', { status })
      await apply('api', { status })
    }
  }

  if (run.settings.sources.repository && !done(record.sources.repository)) {
    const github = run.github
    if (!github || !githubPath(library.repository))
      await apply('repository', {
        status: sourceStatus(
          'skipped',
          run.now,
          github ? 'not a GitHub repository' : 'no GitHub client configured',
        ),
      })
    else
      await attempt('repository', async () => {
        const size = await repositorySize(run, github, library)
        if (size !== undefined && size > (run.maxRepositoryKb ?? 500_000))
          return { status: sourceStatus('skipped', run.now, `repository is ${size} KB`) }
        const resolved = await tagOf(run, library, record)
        return repositorySource(run.store, github, target(), resolved.ref).then((outcome) => ({
          ...outcome,
          patch: {
            ...(resolved.tag ? { tag: resolved.tag } : {}),
            ...(resolved.commit ? { commit: resolved.commit } : {}),
          },
        }))
      })
  }
  return record
}

async function tagOf(run: RunContext, library: LibraryRecord, record: LibraryVersionRecord) {
  if (record.tag)
    return { tag: record.tag, ref: record.tag, ...(record.commit ? { commit: record.commit } : {}) }
  if (!run.resolveTag || !library.repository)
    return record.commit ? { commit: record.commit, ref: record.commit } : {}
  return run.resolveTag({
    repository: library.repository,
    name: library.name,
    version: record.version,
    ...(record.commit ? { commit: record.commit } : {}),
  })
}

function repositorySize(run: RunContext, github: GitHubClient, library: LibraryRecord) {
  const path = githubPath(library.repository)
  if (!path) return Promise.resolve(undefined)
  let pending = run.repositoryKb.get(path)
  if (!pending) {
    pending = github
      .rest<{ size?: number }>(`/repos/${path}`)
      .then((response) => response.data?.size)
    run.repositoryKb.set(path, pending)
  }
  return pending
}

async function indexReleases(
  run: RunContext,
  library: LibraryRecord,
  versions: LibraryVersionRecord[],
  matrixChanged: boolean,
): Promise<void> {
  if (!versions.length) return
  if (!matrixChanged && versions.every((record) => done(record.sources.releases))) return
  const ref = refOf(library)
  const path = githubPath(library.repository)
  const save = async (record: LibraryVersionRecord, status: LibrarySourceStatus) => {
    const next = {
      ...record,
      sources: { ...record.sources, releases: status },
      updatedAt: run.now().toISOString(),
    }
    await run.store.putVersion(next)
    return next
  }
  const all = async (status: LibrarySourceStatus) => {
    for (const [index, record] of versions.entries()) versions[index] = await save(record, status)
  }
  if (!run.github || !path) {
    await all(
      sourceStatus(
        'skipped',
        run.now,
        run.github ? 'not a GitHub repository' : 'no GitHub client configured',
      ),
    )
    return
  }
  try {
    const releases = await listReleases(run.github, path)
    const assigned = assignReleases(
      releases,
      versions.map((record) => record.version),
      library.name,
      library.repository?.directory,
    )
    for (const [index, record] of versions.entries()) {
      run.signal?.throwIfAborted()
      const notes = assigned.get(record.version) ?? []
      await run.store.replaceChunks(
        ref,
        record.version,
        'releases',
        notes.flatMap(({ release }) => releaseChunks(ref, release)),
      )
      versions[index] = await save(
        record,
        releases.length
          ? sourceStatus('ok', run.now)
          : sourceStatus('missing', run.now, 'the repository has no releases'),
      )
    }
  } catch (error) {
    run.signal?.throwIfAborted()
    await all(fail(run, ref, 'releases', error))
  }
}

async function runHooks(run: RunContext, library: LibraryRecord, versions: LibraryVersionRecord[]) {
  const used = versions
    .filter((record) => record.roles.includes('used') && record.publishedAt)
    .toSorted((a, b) => compareSemver(a.version, b.version))[0]
  const context: LibraryHookContext = {
    versions,
    ...(used?.publishedAt ? { oldestUsedReleaseAt: used.publishedAt } : {}),
    now: run.now(),
    ...(run.signal ? { signal: run.signal } : {}),
  }
  if (run.issueIndexer && run.settings.sources.issues) {
    run.signal?.throwIfAborted()
    try {
      await run.issueIndexer((await run.store.getLibrary(library)) ?? library, context)
    } catch (error) {
      run.signal?.throwIfAborted()
      await setLibraryStatus(run, library, 'issues', fail(run, library, 'issues', error))
    }
  }
  const repositoryDocs = versions.some((record) => record.sources.repository?.status === 'ok')
  if (run.siteSource && run.settings.sources.site && !repositoryDocs) {
    run.signal?.throwIfAborted()
    const ref = refOf(library)
    const latest = versions.find((record) => record.roles.includes('latest')) ?? versions[0]
    const highestUsed = versions.find((record) => record.roles.includes('used'))
    const targets = [latest, highestUsed].filter(
      (record, index, list): record is LibraryVersionRecord =>
        record !== undefined &&
        list.indexOf(record) === index &&
        (index === 0 || majorOf(record.version) !== majorOf(latest?.version ?? '')),
    )
    const previous = library.sources.site
    const fresh = done(previous) && elapsedDays(previous?.at, run.now()) < run.settings.graceDays
    for (const target of targets) {
      const indexed = await run.store.listChunks(
        { ...ref, version: target.version, source: 'site' },
        1,
      )
      if (fresh && (indexed.length || previous?.status === 'missing')) continue
      try {
        const current = (await run.store.getLibrary(library)) ?? library
        const site = await run.siteSource(current, target.version)
        await run.store.replaceChunks(ref, target.version, 'site', site.chunks)
        await setLibraryStatus(run, library, 'site', site.status)
      } catch (error) {
        run.signal?.throwIfAborted()
        await setLibraryStatus(
          run,
          library,
          'site',
          fail(run, library, 'site', error, target.version),
        )
      }
    }
  }
}

async function setLibraryStatus(
  run: RunContext,
  library: LibraryRecord,
  source: LibrarySourceKind,
  status: LibrarySourceStatus,
) {
  const latest = (await run.store.getLibrary(library)) ?? library
  await run.store.putLibrary({ ...latest, sources: { ...latest.sources, [source]: status } })
}

async function dropUnused(run: RunContext, active: Set<string>): Promise<void> {
  const at = run.now()
  for (const library of await run.store.listLibraries()) {
    if (active.has(libraryKey(library))) continue
    run.signal?.throwIfAborted()
    const versions = await run.store.listVersions(library)
    let keep = elapsedDays(library.updatedAt, at) < run.settings.graceDays
    for (const record of versions) {
      if (!record.leftAt || record.roles.length) {
        await run.store.putVersion({
          ...record,
          roles: [],
          usedBy: [],
          leftAt: record.leftAt ?? at.toISOString(),
          updatedAt: at.toISOString(),
        })
        keep = true
      } else if (elapsedDays(record.leftAt, at) < run.settings.graceDays) keep = true
    }
    if (keep) continue
    await run.store.removeLibrary(library)
    run.summary.librariesRemoved += 1
    run.summary.versionsRemoved += versions.length
  }
}
