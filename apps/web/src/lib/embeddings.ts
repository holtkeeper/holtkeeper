import type { EmbeddingModelView, KnowledgeEmbeddingsStatus } from '@holtkeeper/api'

import { formatDateTime } from './format.ts'

/** Model `knowledge.embeddings` uses when none is set; mirrors the setting's default. */
export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small'

/** The `knowledge.embeddings` value as the Semantic search form edits it. */
export interface EmbeddingsDraft {
  enabled: boolean
  /** Credential id or name; empty for the AI provider's credential. */
  credential: string
  model: string
  /** Typed dimensions; empty for the model's own. */
  dimensions: string
}

/** The stored `knowledge.embeddings` value, as it is saved. */
export interface EmbeddingsValue {
  enabled: boolean
  credential?: string
  model: string
  dimensions?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const trimmed = (field: unknown) => (typeof field === 'string' ? field.trim() : '')

/** The form of a stored value; anything missing or malformed takes the setting's default. */
export function embeddingsDraft(value: unknown): EmbeddingsDraft {
  const record = isRecord(value) ? value : {}
  return {
    enabled: record.enabled === true,
    credential: trimmed(record.credential),
    model: trimmed(record.model) || DEFAULT_EMBEDDING_MODEL,
    dimensions:
      typeof record.dimensions === 'number' && Number.isFinite(record.dimensions)
        ? String(record.dimensions)
        : '',
  }
}

/** The value to save, or why the form cannot be saved (the setting's own validation). */
export function parseEmbeddingsDraft(
  draft: EmbeddingsDraft,
): { value: EmbeddingsValue } | { error: string } {
  const model = draft.model.trim()
  if (!model) return { error: 'Pick or type a model.' }
  const credential = draft.credential.trim()
  const typed = draft.dimensions.trim()
  let dimensions: number | undefined
  if (typed) {
    dimensions = Number(typed)
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192)
      return {
        error: 'Dimensions are a whole number from 1 to 8192, or empty for the model’s own.',
      }
  }
  return {
    value: {
      enabled: draft.enabled,
      ...(credential && { credential }),
      model,
      ...(dimensions !== undefined && { dimensions }),
    },
  }
}

/** Whether two drafts would save the same value. */
export const sameEmbeddingsDraft = (a: EmbeddingsDraft, b: EmbeddingsDraft): boolean =>
  a.enabled === b.enabled &&
  a.credential.trim() === b.credential.trim() &&
  a.model.trim() === b.model.trim() &&
  a.dimensions.trim() === b.dimensions.trim()

/** `$0.02 / 1M tokens`; `undefined` when the endpoint lists no price. */
export function formatEmbeddingPrice(price: number | undefined): string | undefined {
  if (price === undefined || !Number.isFinite(price) || price < 0) return undefined
  return `$${price.toLocaleString('en', { maximumSignificantDigits: 3 })} / 1M tokens`
}

/** One option of the model picker. */
export interface EmbeddingModelOption {
  id: string
  /** Dimensions and price, when known. */
  detail?: string
  /** The setting names it but the endpoint does not list it. */
  unlisted?: boolean
}

/**
 * The model picker's options: the listed models by id, with the current model first when the
 * endpoint does not list it (a typo or a model the endpoint keeps quiet about stays visible).
 */
export function embeddingModelOptions(
  models: readonly EmbeddingModelView[],
  current: string,
): EmbeddingModelOption[] {
  const listed = models
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map((model): EmbeddingModelOption => {
      const detail = [
        model.dimensions !== undefined ? `${model.dimensions} dimensions` : undefined,
        formatEmbeddingPrice(model.pricePerMillionTokens),
      ]
        .filter(Boolean)
        .join(' · ')
      const option: EmbeddingModelOption = { id: model.id }
      if (detail) option.detail = detail
      return option
    })
  const wanted = current.trim()
  if (!wanted || listed.some((option) => option.id === wanted)) return listed
  return [{ id: wanted, unlisted: true }, ...listed]
}

/** Tone of the status tag. */
type StatusTone = 'success' | 'warning' | 'danger' | 'default'

/** The status line of Semantic search: a tag and the facts after it. */
export interface EmbeddingsStatusLine {
  label: string
  tone: StatusTone
  /** Notes indexed, model and last run, in that order, those known. */
  facts: string[]
  error?: string
}

const stateLabels: Record<KnowledgeEmbeddingsStatus['state'], { label: string; tone: StatusTone }> =
  {
    off: { label: 'Off', tone: 'default' },
    indexing: { label: 'Indexing', tone: 'warning' },
    ready: { label: 'Ready', tone: 'success' },
    error: { label: 'Error', tone: 'danger' },
  }

/** What the status line says for a status from `GET /api/knowledge/embeddings`. */
export function embeddingsStatusLine(status: KnowledgeEmbeddingsStatus): EmbeddingsStatusLine {
  const { label, tone } = stateLabels[status.state]
  if (status.state === 'off')
    return { label, tone, facts: ['Search and Guide notes use full text only'] }
  const facts = [
    `${status.indexed} of ${status.total} ${status.total === 1 ? 'note' : 'notes'} indexed`,
    ...(status.model ? [status.model] : []),
    ...(status.lastRunAt ? [`last run ${formatDateTime(status.lastRunAt)}`] : []),
  ]
  return {
    label,
    tone,
    facts,
    ...(status.error && { error: `${status.error}. Search falls back to full text meanwhile.` }),
  }
}
