import { type RepoTarget, scopeCoversRepo } from '@holtkeeper/access'
import { type BudgetGuard, budgetGuard, usageRecorder } from '@holtkeeper/ai-usage'
import type { EmbeddingModelList, KnowledgeEmbeddingsStatus } from '@holtkeeper/api'
import type { CredentialService, CredentialView } from '@holtkeeper/credentials'
import { type EmbedPurpose, type Embedder, contentHash, cosine } from '@holtkeeper/embed'
import {
  type EmbeddingModel,
  EmbeddingError,
  createOpenAiEmbedder,
  listEmbeddingModels,
} from '@holtkeeper/embed-openai'
import { embeddingSubject, embeddingText } from '@holtkeeper/knowledge'
import {
  type KnowledgeEmbeddings as EmbeddingsSetting,
  knowledgeEmbeddings as embeddingsDefinition,
  resolveGlobalSetting,
} from '@holtkeeper/settings'
import type { KnowledgeEntry, Store } from '@holtkeeper/store'

import type { LeaderDuty } from './leader.ts'

/** Task kind of the AI usage records embedding calls leave. */
const EMBEDDING_TASK_KIND = 'embedding'

/**
 * The stand-in repository embedding usage is recorded and budget-checked for: knowledge belongs
 * to no one repository, so only budgets for everything cover it.
 */
const EMBEDDING_TARGET: RepoTarget = { forge: 'holtkeeper', path: 'knowledge', teams: [] }

const STATUS_KEY = 'embeddings:status'
const DIRTY_KEY = 'embeddings:dirty'
const SUBJECT_PREFIX = 'knowledge:'
/** Characters of a query that get embedded; the models stop at about 8000 tokens. */
const MAX_QUERY_CHARS = 8000
/** Characters per token when estimating the cost of a call before it is made. */
const CHARS_PER_TOKEN = 4

/** Ranks and dedupes knowledge by meaning; what Guide resolution, search and proposals use. */
export interface KnowledgeSemantics {
  /**
   * Entry id → cosine between `query` and each entry's vector, for `ids` (default every entry with
   * a vector). `undefined` when vectors are off, failing, not built yet or over budget, so callers
   * stay full text. Never throws.
   */
  semantic(query: string, ids?: Iterable<string>): Promise<ReadonlyMap<string, number> | undefined>
  /**
   * The cosine between `text` (a proposal, as `embeddingText` renders it) and a stored entry, for
   * `proposeEntry`'s `similarity`; `undefined` like `semantic`. Never throws.
   */
  similarity(text: string): Promise<((candidate: KnowledgeEntry) => number | undefined) | undefined>
}

/** Vectors of knowledge notes: the indexer, query-time similarity and their status. */
export interface KnowledgeEmbeddings extends KnowledgeSemantics {
  /** Where indexing stands, as `GET /api/knowledge/embeddings` answers it. Never throws. */
  status(): Promise<KnowledgeEmbeddingsStatus>
  /**
   * Knowledge changed: the leader indexes a few seconds later; other processes leave a marker in
   * `Store.kv` the leader polls. Never throws.
   */
  touch(): void
  /** One indexing run now, in this process; resolves with the status after it. Never throws. */
  index(): Promise<KnowledgeEmbeddingsStatus>
  /** Drops every stored vector and asks the leader to embed everything again. */
  reindex(): Promise<KnowledgeEmbeddingsStatus>
  /**
   * The embedding models of an `ai-sdk` credential (id or name; default the one the setting or
   * `llm.provider` names). Endpoint errors come back as `error`, never thrown.
   */
  models(credential?: string): Promise<EmbeddingModelList>
  /** The leader duty: index on start, after knowledge writes and every `intervalMs`. */
  duty: LeaderDuty
  /** Records the query usage gathered so far; call on shutdown. */
  flush(): Promise<void>
}

/** What `createEmbedder` gets: an `ai-sdk` credential's endpoint and key, and the setting. */
export interface EmbedderInput {
  url: string
  apiKey: string
  model: string
  dimensions?: number
}

export interface KnowledgeEmbeddingsOptions {
  store: Pick<Store, 'knowledge' | 'embeddings' | 'settings' | 'aiUsage' | 'audit'> &
    Partial<Pick<Store, 'kv'>>
  credentials: Pick<CredentialService, 'list' | 'reveal'>
  now?: () => Date
  log?: (line: string) => void
  /** Builds the embedder of a credential. Default `createOpenAiEmbedder`; tests pass a fake. */
  createEmbedder?: (input: EmbedderInput) => Embedder
  /** Lists a credential's models (prices, the models picker). Default `listEmbeddingModels`. */
  listModels?: (input: { url: string; apiKey: string }) => Promise<EmbeddingModel[]>
  /** Budget guard checked before every embedding call. Default `budgetGuard`; `false` disables it. */
  budgets?: BudgetGuard | false
  /** Periodic indexing. Default 10 minutes. */
  intervalMs?: number
  /** Wait after a knowledge write before indexing (writes in between restart it). Default 5 s. */
  debounceMs?: number
  /** How often the leader reads the marker other processes leave. Default 30 s. */
  pollMs?: number
  /** Notes per embedding call. Default 128. */
  batchSize?: number
  /** Query vectors kept (least recently used dropped first). Default 500. */
  queryCacheSize?: number
  /** How long stored vectors are reused for queries before they are read again. Default 60 s. */
  vectorCacheMs?: number
  /** How long the setting and credential are reused before they are read again. Default 10 s. */
  configCacheMs?: number
  /** Query usage is recorded at most this often, as one record. Default 10 minutes. */
  queryFlushMs?: number
}

type Resolved =
  | { state: 'off' }
  | { state: 'error'; setting: EmbeddingsSetting; error: string }
  | {
      state: 'on'
      setting: EmbeddingsSetting
      credential: CredentialView
      embedder: Embedder
      /** Credential version, model and dimensions: a new key means another embedder. */
      key: string
    }

type On = Extract<Resolved, { state: 'on' }>

/** The status as stored, with what it was computed for. */
interface SavedStatus extends KnowledgeEmbeddingsStatus {
  /** `<model>@<dimensions>` of the setting the run used. */
  setting?: string
}

const settingKey = (setting: EmbeddingsSetting) => `${setting.model}@${setting.dimensions ?? ''}`

const live = (entry: KnowledgeEntry) => entry.status === 'proposed' || entry.status === 'accepted'

const messageOf = (error: unknown) => {
  if (error instanceof EmbeddingError)
    return error.status ? `${error.message} (HTTP ${error.status})` : error.message
  return error instanceof Error ? error.message : String(error)
}

/** Groups errors for logging: one line per kind until a run succeeds again. */
const errorKind = (error: unknown) =>
  error instanceof EmbeddingError
    ? `embedding:${error.status}:${error.code ?? ''}`
    : error instanceof Error
      ? `${error.name}:${error.message}`
      : String(error)

/** The credential `llm.provider` names (as `agent.ts` reads it), the default for embeddings. */
function providerReference(entries: Parameters<typeof resolveGlobalSetting>[0]) {
  const entry = resolveGlobalSetting(entries, 'llm.provider')
  return entry && !entry.secret && typeof entry.value === 'string' ? entry.value : undefined
}

const isSavedStatus = (value: unknown): value is SavedStatus =>
  typeof value === 'object' &&
  value !== null &&
  'state' in value &&
  ['off', 'indexing', 'ready', 'error'].includes(String(value.state))

/** Cosine of two vectors of one model; `undefined` for vectors of different lengths. */
const compare = (a: Float32Array, b: Float32Array) =>
  a.length === b.length ? cosine(a, b) : undefined

/** The `knowledge.embeddings` value in force; the default (off) when unset or invalid. */
export function embeddingsSettingOf(
  entries: Parameters<typeof resolveGlobalSetting>[0],
): EmbeddingsSetting {
  const entry = resolveGlobalSetting(entries, embeddingsDefinition.key)
  const parsed = embeddingsDefinition.schema.safeParse(
    entry && !entry.secret ? entry.value : undefined,
  )
  return parsed.success ? parsed.data : embeddingsDefinition.schema.parse({})
}

/** The `ai-sdk` credential a reference (id first, then name) names, or why there is none. */
function credentialFor(
  credentials: readonly CredentialView[],
  reference: string | undefined,
): CredentialView | string {
  if (!reference)
    return 'no credential: pick an ai-sdk credential for semantic search or set the AI provider'
  const found =
    credentials.find((credential) => credential.id === reference) ??
    credentials.find((credential) => credential.name === reference)
  if (!found) return `credential "${reference}" does not exist`
  if (found.kind !== 'ai-sdk')
    return `credential "${found.name}" is of kind ${found.kind}; semantic search needs an ai-sdk credential whose endpoint speaks the OpenAI Embeddings format`
  return found
}

/**
 * Vectors of knowledge notes from the global `knowledge.embeddings` setting. Off, misconfigured,
 * failing or over the AI budget, every query answers `undefined` and callers stay full text.
 *
 * - The embedder comes from an `ai-sdk` credential (the setting's, else `llm.provider`'s): its
 *   `url` and decrypted secret, rebuilt when the credential, model or dimensions change. The key
 *   never reaches logs or the status.
 * - The indexer (`duty`, leader only) embeds live notes (proposed, accepted) whose vector of the
 *   current model is missing or whose text changed, removes vectors of other notes, prunes other
 *   models, in batches, and stores its status in `Store.kv` for every process to read.
 * - Every embedding call is checked against the weekly AI budget as automatic work for
 *   `EMBEDDING_TARGET`, and recorded as task kind `embedding` by the `system` actor: one record per
 *   indexing run, query usage gathered into one record at most every `queryFlushMs`. Cost is the
 *   model's catalog price when the endpoint lists one, else unknown.
 * - Query vectors are cached by text (least recently used out first); stored vectors are reread
 *   after `vectorCacheMs`.
 * - Errors are logged once per kind until a run succeeds; the status shows the last one.
 */
export function createKnowledgeEmbeddings(
  options: KnowledgeEmbeddingsOptions,
): KnowledgeEmbeddings {
  const { store, credentials } = options
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => {})
  const createEmbedder =
    options.createEmbedder ??
    ((input: EmbedderInput) =>
      createOpenAiEmbedder({
        url: input.url,
        apiKey: input.apiKey,
        model: input.model,
        ...(input.dimensions !== undefined && { dimensions: input.dimensions }),
      }))
  const listModels = options.listModels ?? ((input) => listEmbeddingModels(input))
  const guard =
    options.budgets === false
      ? undefined
      : (options.budgets ??
        budgetGuard({ settings: store.settings, usage: store.aiUsage, audit: store.audit, now }))
  const record = usageRecorder(store.aiUsage, { now, ...(guard && { budgets: guard }) })
  const intervalMs = options.intervalMs ?? 10 * 60_000
  const debounceMs = options.debounceMs ?? 5000
  const pollMs = options.pollMs ?? 30_000
  const batchSize = Math.max(1, options.batchSize ?? 128)
  const queryCacheSize = Math.max(1, options.queryCacheSize ?? 500)
  const vectorCacheMs = options.vectorCacheMs ?? 60_000
  const configCacheMs = options.configCacheMs ?? 10_000
  const queryFlushMs = options.queryFlushMs ?? 10 * 60_000

  let built: { key: string; embedder: Embedder } | undefined
  let config: { at: number; value: Promise<Resolved> } | undefined
  let localStatus: SavedStatus | undefined
  let queryError: { at: string; message: string } | undefined
  const logged = new Set<string>()
  const queryVectors = new Map<string, Float32Array>()
  let vectors: { key: string; at: number; byId: Map<string, Float32Array> } | undefined
  const prices = new Map<string, { at: number; price: Promise<number | undefined> }>()
  let pendingQueries: { tokens: number; calls: number; durationMs: number; on: On } | undefined
  let lastFlush = now().getTime()

  const noteError = (error: unknown) => {
    const kind = errorKind(error)
    if (logged.has(kind)) return
    logged.add(kind)
    log(`embeddings: ${messageOf(error)}`)
  }

  async function resolveNow(): Promise<Resolved> {
    const [own, provider] = await Promise.all([
      store.settings.list(embeddingsDefinition.key),
      store.settings.list('llm.provider'),
    ])
    const setting = embeddingsSettingOf(own)
    if (!setting.enabled) return { state: 'off' }
    const found = credentialFor(
      await credentials.list(),
      setting.credential ?? providerReference(provider),
    )
    if (typeof found === 'string') return { state: 'error', setting, error: found }
    const key = `${found.id}:${found.updatedAt}:${settingKey(setting)}`
    if (built?.key !== key) {
      const apiKey = await credentials.reveal(found.id)
      built = {
        key,
        embedder: createEmbedder({
          url: found.url,
          apiKey,
          model: setting.model,
          ...(setting.dimensions !== undefined && { dimensions: setting.dimensions }),
        }),
      }
    }
    return { state: 'on', setting, credential: found, embedder: built.embedder, key }
  }

  /** The setting and embedder, reused for `configCacheMs` unless `fresh`. */
  function resolve(fresh = false): Promise<Resolved> {
    const at = now().getTime()
    if (!fresh && config && at - config.at < configCacheMs) return config.value
    const value = resolveNow().catch((error: unknown): Resolved => ({
      state: 'error',
      setting: embeddingsDefinition.schema.parse({ enabled: true }),
      error: messageOf(error),
    }))
    config = { at, value }
    return value
  }

  /** USD per million tokens of the setting's model, from the credential's catalog when listed. */
  function priceOf(on: On): Promise<number | undefined> {
    const at = now().getTime()
    const cached = prices.get(on.key)
    if (cached && at - cached.at < 6 * 3_600_000) return cached.price
    const price = credentials
      .reveal(on.credential.id)
      .then((apiKey) => listModels({ url: on.credential.url, apiKey }))
      .then(
        (models) => models.find((model) => model.id === on.setting.model)?.pricePerMillionTokens,
      )
      .catch(() => undefined)
    prices.set(on.key, { at, price })
    return price
  }

  /** Whether the weekly budget lets automatic work spend `estimateUsd` more. */
  async function allowed(estimateUsd: number): Promise<boolean> {
    if (!guard) return true
    const decision = await guard.check({
      repo: EMBEDDING_TARGET,
      taskKind: EMBEDDING_TASK_KIND,
      interactive: false,
      estimateUsd,
    })
    return decision.allowed
  }

  const estimate = async (on: On, texts: readonly string[]) => {
    const price = await priceOf(on)
    const chars = texts.reduce((sum, text) => sum + text.length, 0)
    return price === undefined ? 0 : ((chars / CHARS_PER_TOKEN) * price) / 1e6
  }

  async function recordUsage(
    on: On,
    usage: { tokens: number; durationMs: number; at: string; subject: string },
  ) {
    if (usage.tokens <= 0) return
    const price = await priceOf(on)
    await record({
      repo: EMBEDDING_TARGET,
      taskKind: EMBEDDING_TASK_KIND,
      provider: on.credential.name,
      model: on.setting.model,
      actor: 'system',
      interactive: false,
      subject: usage.subject,
      at: usage.at,
      durationMs: usage.durationMs,
      result: {
        turns: 0,
        usage: {
          inputTokens: usage.tokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        ...(price !== undefined && { costUsd: (usage.tokens * price) / 1e6 }),
      },
    }).catch((error: unknown) => log(`embeddings: recording usage failed: ${messageOf(error)}`))
  }

  async function flush() {
    const pending = pendingQueries
    pendingQueries = undefined
    lastFlush = now().getTime()
    if (!pending) return
    await recordUsage(pending.on, {
      tokens: pending.tokens,
      durationMs: pending.durationMs,
      at: now().toISOString(),
      subject: `${pending.calls} ${pending.calls === 1 ? 'query' : 'queries'}`,
    })
  }

  /** The embedder's id; an unknown model learns its dimensions from one tiny call first. */
  async function idOf(on: On): Promise<string> {
    try {
      return on.embedder.id
    } catch {
      if (!(await allowed(0))) throw new Error('the weekly AI budget is used up')
      const started = now()
      const result = await on.embedder.embed(['dimensions'], 'query')
      await recordUsage(on, {
        tokens: result.tokens,
        durationMs: now().getTime() - started.getTime(),
        at: started.toISOString(),
        subject: 'dimensions probe',
      })
      return on.embedder.id
    }
  }

  async function saveStatus(value: SavedStatus) {
    localStatus = value
    await store.kv?.set(STATUS_KEY, value).catch(() => {})
  }

  async function savedStatus(): Promise<SavedStatus | undefined> {
    const stored = await store.kv?.get(STATUS_KEY).catch(() => undefined)
    return isSavedStatus(stored) ? stored : localStatus
  }

  const publicStatus = ({ setting: _setting, ...rest }: SavedStatus): KnowledgeEmbeddingsStatus =>
    rest

  async function runIndex(): Promise<void> {
    const resolved = await resolve(true)
    const previous = await savedStatus()
    const lastRunAt = previous?.lastRunAt
    if (resolved.state === 'off') {
      await saveStatus({ state: 'off', indexed: 0, total: 0, ...(lastRunAt && { lastRunAt }) })
      return
    }
    const model = resolved.setting.model
    const setting = settingKey(resolved.setting)
    if (resolved.state === 'error') {
      noteError(new Error(resolved.error))
      await saveStatus({
        state: 'error',
        model,
        setting,
        indexed: previous?.setting === setting ? previous.indexed : 0,
        total: previous?.total ?? 0,
        error: resolved.error,
        ...(lastRunAt && { lastRunAt }),
      })
      return
    }
    const started = now()
    let tokens = 0
    let indexed = 0
    let total = 0
    try {
      const entries = (await store.knowledge.list()).filter(live)
      total = entries.length
      const id = await idOf(resolved)
      const stored = await store.embeddings.list({ model: id, prefix: SUBJECT_PREFIX })
      const hashes = new Map(stored.map((row) => [row.subject, row.hash]))
      const wanted = new Set(entries.map((entry) => embeddingSubject(entry.id)))
      const gone = stored.map((row) => row.subject).filter((subject) => !wanted.has(subject))
      if (gone.length) await store.embeddings.remove(gone)
      await store.embeddings.pruneModels(id)
      const pending = entries
        .map((entry) => {
          const text = embeddingText(entry)
          return { subject: embeddingSubject(entry.id), text, hash: contentHash(text) }
        })
        .filter((item) => hashes.get(item.subject) !== item.hash)
      indexed = total - pending.length
      const progress = (state: KnowledgeEmbeddingsStatus['state'], extra = {}) =>
        saveStatus({
          state,
          model,
          setting,
          indexed,
          total,
          ...(lastRunAt && { lastRunAt }),
          ...extra,
        })
      if (pending.length) await progress('indexing')
      for (let start = 0; start < pending.length; start += batchSize) {
        const batch = pending.slice(start, start + batchSize)
        const texts = batch.map((item) => item.text)
        // oxlint-disable-next-line no-await-in-loop -- one batch after another, each checked against the budget
        if (!(await allowed(await estimate(resolved, texts)))) {
          // oxlint-disable-next-line no-await-in-loop -- the loop ends here
          await progress('error', {
            error: `the weekly AI budget is used up; ${pending.length - start} notes wait for it and search stays full text`,
          })
          return
        }
        // oxlint-disable-next-line no-await-in-loop -- see above
        const result = await resolved.embedder.embed(texts, 'document')
        tokens += result.tokens
        // oxlint-disable-next-line no-await-in-loop -- see above
        await store.embeddings.put(
          batch.map((item, i) => ({
            subject: item.subject,
            model: id,
            hash: item.hash,
            vector: result.vectors[i] ?? new Float32Array(),
          })),
        )
        indexed += batch.length
        // oxlint-disable-next-line no-await-in-loop -- see above
        await progress('indexing')
      }
      vectors = undefined
      logged.clear()
      await saveStatus({
        state: 'ready',
        model,
        setting,
        indexed,
        total,
        lastRunAt: now().toISOString(),
      })
      if (pending.length) log(`embeddings: embedded ${pending.length} notes with ${model}`)
    } catch (error) {
      noteError(error)
      await saveStatus({
        state: 'error',
        model,
        setting,
        indexed,
        total,
        error: messageOf(error),
        lastRunAt: now().toISOString(),
      })
    } finally {
      await recordUsage(resolved, {
        tokens,
        durationMs: now().getTime() - started.getTime(),
        at: started.toISOString(),
        subject: 'knowledge index',
      })
    }
  }

  /** The vector of `text`, from the cache or one embedding call; `undefined` over budget. */
  async function vectorOf(
    on: On,
    text: string,
    purpose: EmbedPurpose,
  ): Promise<Float32Array | undefined> {
    const key = `${on.key}:${purpose}:${contentHash(text)}`
    const hit = queryVectors.get(key)
    if (hit) {
      queryVectors.delete(key)
      queryVectors.set(key, hit)
      return hit
    }
    if (!(await allowed(await estimate(on, [text])))) return undefined
    const started = now()
    const result = await on.embedder.embed([text], purpose)
    const vector = result.vectors[0]
    if (!vector) return undefined
    queryVectors.set(key, vector)
    for (const old of queryVectors.keys()) {
      if (queryVectors.size <= queryCacheSize) break
      queryVectors.delete(old)
    }
    const durationMs = now().getTime() - started.getTime()
    pendingQueries =
      pendingQueries?.on.key === on.key
        ? {
            ...pendingQueries,
            tokens: pendingQueries.tokens + result.tokens,
            calls: pendingQueries.calls + 1,
            durationMs: pendingQueries.durationMs + durationMs,
          }
        : { on, tokens: result.tokens, calls: 1, durationMs }
    if (now().getTime() - lastFlush >= queryFlushMs) await flush()
    return vector
  }

  /** Stored vectors of the current model by entry id, reread after `vectorCacheMs`. */
  async function storedVectors(on: On): Promise<Map<string, Float32Array>> {
    const id = on.embedder.id
    const at = now().getTime()
    if (vectors?.key === id && at - vectors.at < vectorCacheMs) return vectors.byId
    const rows = await store.embeddings.list({ model: id, prefix: SUBJECT_PREFIX })
    const byId = new Map(rows.map((row) => [row.subject.slice(SUBJECT_PREFIX.length), row.vector]))
    vectors = { key: id, at, byId }
    return byId
  }

  /** The query's vector and the stored vectors, or `undefined` when vectors cannot help. */
  async function prepare(text: string, purpose: EmbedPurpose) {
    const trimmed = text.trim().slice(0, MAX_QUERY_CHARS)
    if (!trimmed) return undefined
    try {
      const resolved = await resolve()
      if (resolved.state !== 'on') return undefined
      const vector = await vectorOf(resolved, trimmed, purpose)
      if (!vector) return undefined
      const byId = await storedVectors(resolved)
      if (!byId.size) return undefined
      return { vector, byId }
    } catch (error) {
      noteError(error)
      queryError = { at: now().toISOString(), message: messageOf(error) }
      return undefined
    }
  }

  let leading = false
  let running: Promise<void> | undefined
  let again = false
  let debounce: ReturnType<typeof setTimeout> | undefined

  const run = (): Promise<void> => {
    if (running) {
      again = true
      return running
    }
    running = runIndex()
      .catch((error: unknown) => noteError(error))
      .finally(() => {
        running = undefined
        if (again && leading) {
          again = false
          void run()
        }
      })
    return running
  }

  const schedule = () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = undefined
      void run()
    }, debounceMs)
  }

  const touch = () => {
    if (leading) return schedule()
    void store.kv?.set(DIRTY_KEY, now().toISOString()).catch(() => {})
  }

  async function status(): Promise<KnowledgeEmbeddingsStatus> {
    const resolved = await resolve()
    if (resolved.state === 'off') return { state: 'off', indexed: 0, total: 0 }
    const saved = await savedStatus()
    const model = resolved.setting.model
    const current = saved?.setting === settingKey(resolved.setting) ? saved : undefined
    const lastRunAt = saved?.lastRunAt
    if (resolved.state === 'error')
      return {
        state: 'error',
        model,
        indexed: current?.indexed ?? 0,
        total: saved?.total ?? 0,
        error: resolved.error,
        ...(lastRunAt && { lastRunAt }),
      }
    if (!current || current.state === 'off')
      return {
        state: 'indexing',
        model,
        indexed: 0,
        total: saved?.total ?? 0,
        ...(lastRunAt && { lastRunAt }),
      }
    if (queryError && (!lastRunAt || queryError.at > lastRunAt))
      return { ...publicStatus(current), state: 'error', error: queryError.message }
    return publicStatus(current)
  }

  return {
    async semantic(query, ids) {
      const prepared = await prepare(query, 'query')
      if (!prepared) return undefined
      const result = new Map<string, number>()
      for (const id of ids ?? prepared.byId.keys()) {
        const stored = prepared.byId.get(id)
        const value = stored && compare(prepared.vector, stored)
        if (value !== undefined) result.set(id, value)
      }
      return result
    },
    async similarity(text) {
      const prepared = await prepare(text, 'document')
      if (!prepared) return undefined
      return (candidate) => {
        const stored = prepared.byId.get(candidate.id)
        return stored && compare(prepared.vector, stored)
      }
    },
    status: () =>
      status().catch((error: unknown): KnowledgeEmbeddingsStatus => ({
        state: 'error',
        indexed: 0,
        total: 0,
        error: messageOf(error),
      })),
    touch,
    async index() {
      await run()
      return status()
    },
    async reindex() {
      const resolved = await resolve(true)
      if (resolved.state === 'off') return status()
      await store.embeddings.pruneModels('')
      vectors = undefined
      queryVectors.clear()
      const previous = await savedStatus()
      await saveStatus({
        state: 'indexing',
        model: resolved.setting.model,
        setting: settingKey(resolved.setting),
        indexed: 0,
        total: previous?.total ?? 0,
        ...(previous?.lastRunAt && { lastRunAt: previous.lastRunAt }),
      })
      touch()
      return status()
    },
    async models(reference) {
      const [own, provider] = await Promise.all([
        store.settings.list(embeddingsDefinition.key),
        store.settings.list('llm.provider'),
      ])
      const found = credentialFor(
        await credentials.list(),
        reference ?? embeddingsSettingOf(own).credential ?? providerReference(provider),
      )
      if (typeof found === 'string') return { models: [], error: found }
      const credential = { id: found.id, name: found.name }
      try {
        const apiKey = await credentials.reveal(found.id)
        return { credential, models: await listModels({ url: found.url, apiKey }) }
      } catch (error) {
        return { credential, models: [], error: messageOf(error) }
      }
    },
    duty: async () => {
      leading = true
      let lastDirty = await store.kv?.get(DIRTY_KEY).catch(() => undefined)
      void run()
      const interval = setInterval(() => void run(), intervalMs)
      const checkDirty = async () => {
        const marker = await store.kv?.get(DIRTY_KEY).catch(() => undefined)
        if (marker === undefined || marker === lastDirty) return
        lastDirty = marker
        schedule()
      }
      const poll = store.kv ? setInterval(() => void checkDirty(), pollMs) : undefined
      return async () => {
        leading = false
        clearInterval(interval)
        if (poll) clearInterval(poll)
        if (debounce) clearTimeout(debounce)
        debounce = undefined
        await running
        await flush()
      }
    },
    flush,
  }
}

/**
 * Cosines for a Guide resolution: the query against the accepted entries whose scope covers the
 * repository or one of its `neighbours`, the candidates `selectForTask` and
 * `selectNeighbourKnowledge` rank. `undefined` without vectors.
 */
export async function guideSemantic(
  semantics: KnowledgeSemantics | undefined,
  store: Pick<Store, 'knowledge'>,
  repo: RepoTarget,
  query: string | undefined,
  neighbours: readonly RepoTarget[] = [],
): Promise<ReadonlyMap<string, number> | undefined> {
  if (!semantics || !query?.trim()) return undefined
  const repos = [repo, ...neighbours]
  const candidates = (await store.knowledge.list({ status: 'accepted' }))
    .filter((entry) => repos.some((target) => scopeCoversRepo(entry.scope, target)))
    .map((entry) => entry.id)
  if (!candidates.length) return undefined
  return semantics.semantic(query, candidates)
}

/**
 * `store` whose knowledge writes (`put`, `remove`) call `onWrite` once they succeed; every other
 * part is the store itself. The server wraps its store with it so any write re-embeds.
 */
export function watchKnowledgeWrites<S extends Pick<Store, 'knowledge'>>(
  store: S,
  onWrite: () => void,
): S {
  const knowledge = store.knowledge
  const watched: Store['knowledge'] = {
    put: async (entry) => {
      const stored = await knowledge.put(entry)
      onWrite()
      return stored
    },
    get: (id) => knowledge.get(id),
    history: (id) => knowledge.history(id),
    list: (filter) => knowledge.list(filter),
    remove: async (id) => {
      await knowledge.remove(id)
      onWrite()
    },
    search: (text, filter, limit) => knowledge.search(text, filter, limit),
  }
  // A copy rather than a prototype link, so spreading the result keeps every part.
  const wrapped: S = Object.assign(Object.create(Object.getPrototypeOf(store)), store)
  wrapped.knowledge = watched
  return wrapped
}
