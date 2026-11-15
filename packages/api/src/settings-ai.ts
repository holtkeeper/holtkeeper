import type { Scope } from '@holtkeeper/access'
import type { Timestamp } from '@holtkeeper/store'

import type { AiBudgetStatus, AiBudgetWeek, WebhookHealthSummary } from './types.ts'

/** One task kind's share of this week's AI spend, e.g. `review`, `chat`, `guide`. */
export interface AiFeatureSpend {
  /** The task kind runs recorded, `other` when they recorded none. */
  feature: string
  costUsd: number
  runs: number
}

/** A scoped `llm.budget` entry with what its repositories spent this week. */
export interface AiScopeCapView {
  settingId: string
  scope: Scope
  weeklyUsd: number
  reserveUsd: number
  action: 'block' | 'warn'
  warnPercent: number
  spentUsd: number
  /** `spentUsd / weeklyUsd * 100`. */
  percent: number
}

/**
 * `GET /api/ai/budget` — Settings › AI › Budgets for the current week, over the usage the caller's
 * `ai:read` grants cover. Needs `ai:read` somewhere.
 */
export interface AiBudgetOverview {
  /** Monday 00:00 to the next Monday in the instance time zone. */
  week: AiBudgetWeek
  /** This week's spend the caller may read. */
  spentUsd: number
  runs: number
  /** The readable budget covering the most (the global one, else the default); absent with none. */
  budget?: AiBudgetStatus
  /** Who last changed the global `llm.budget` entry; absent while the defaults apply. */
  budgetChanged?: { at: Timestamp; by: string }
  /** Spend per task kind, largest first, without kinds that spent nothing. */
  byFeature: AiFeatureSpend[]
  /** Readable `llm.budget` entries narrower than everything, fullest first. */
  scopes: AiScopeCapView[]
}

/** One tool internal agents or MCP clients may call, as the read-only registry lists it. */
export interface AgentToolView {
  name: string
  toolset: string
  description: string
  /** The tool changes nothing. */
  readOnly: boolean
  /**
   * Who gets the tool: task kinds whose agents mount its toolset (`review`, `chat`, `write-task`)
   * and `mcp` for MCP clients.
   */
  usedBy: string[]
}

/** `GET /api/ai/tools`: every registry tool, sorted by toolset and name. Needs `ai:read` somewhere. */
export interface AgentToolList {
  tools: AgentToolView[]
}

/** A panel forge as Settings › Integrations shows it. */
export interface IntegrationForgeView {
  id: string
  kind: string
  url: string
  credentialId?: string
  /** Fleet repositories on the forge (its include patterns plus the teams' owns and consumes). */
  repos: number
  /** When the forge last delivered a webhook; absent before the first. */
  lastWebhookAt?: Timestamp
  /** Whether a webhook secret is set up for the forge. */
  webhook: boolean
  /** Holtkeeper's hooks on the forge (forge-wide and per repository); absent before a check. */
  webhookHealth?: WebhookHealthSummary
}

/** `GET /api/integrations/forges`; needs a global `settings:read`. */
export interface IntegrationForgeList {
  forges: IntegrationForgeView[]
}

/** Where vectors of knowledge notes stand (`knowledge.embeddings`). */
export type KnowledgeEmbeddingsState = 'off' | 'indexing' | 'ready' | 'error'

/**
 * `GET /api/knowledge/embeddings` (`knowledge:read` somewhere) and the answer of `POST
 * /api/knowledge/embeddings/reindex`. Vectors are optional: whatever the state, search and the
 * Guide keep working on full text.
 */
export interface KnowledgeEmbeddingsStatus {
  /**
   * `off`: the setting is off. `indexing`: notes are being embedded, or wait for the next run.
   * `ready`: every live note (proposed or accepted) has a vector of the current model. `error`:
   * the last run, the credential or the budget stopped it; `error` says why.
   */
  state: KnowledgeEmbeddingsState
  /** The model of the setting, e.g. `openai/text-embedding-3-small`; absent while off. */
  model?: string
  /** Live notes with a vector of the current model and text. */
  indexed: number
  /** Live notes (proposed and accepted). */
  total: number
  /** Why the state is `error`, or why notes wait; never holds a key. */
  error?: string
  /** When the indexer last finished a run. */
  lastRunAt?: Timestamp
}

/** An embedding model a credential can use. */
export interface EmbeddingModelView {
  /** The id the setting's `model` takes, e.g. `openai/text-embedding-3-small`. */
  id: string
  /** Default vector length, when known. */
  dimensions?: number
  /** USD per million input tokens, when the endpoint's catalog has prices. */
  pricePerMillionTokens?: number
}

/**
 * `GET /api/knowledge/embeddings/models?credential=` (a global `settings:write`): the embedding
 * models of an `ai-sdk` credential (by id or name; default the one the setting or `llm.provider`
 * names), sorted by id. A failing endpoint answers 200 with no models and `error`.
 */
export interface EmbeddingModelList {
  /** The credential asked, absent when none could be picked. */
  credential?: { id: string; name: string }
  models: EmbeddingModelView[]
  error?: string
}
