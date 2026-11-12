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
  /** Repositories polling listed on the forge plus exact group includes. */
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
