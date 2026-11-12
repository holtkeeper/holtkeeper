import type { ModelTier } from './tiers.ts'
import type { AgentUsage } from './types.ts'

/** Which loop ran a task: Claude Code through the Claude Agent SDK, or the Vercel AI SDK. */
export type AgentRuntime = 'claude-sdk' | 'ai-sdk'

/** One tool call the model made. */
export interface TranscriptToolCall {
  id: string
  name: string
  input: unknown
}

/** One event of an agent run, in the order it happened. */
export type TranscriptEntry =
  | {
      type: 'start'
      runtime: AgentRuntime
      model: string
      tier: ModelTier
      taskKind?: string
      /** Tool names the run could call. */
      tools: string[]
      system?: string
      prompt: string
    }
  | {
      type: 'assistant'
      text?: string
      /** The model's reasoning summary or text, when the provider returns it. */
      reasoning?: string
      toolCalls?: TranscriptToolCall[]
    }
  | {
      type: 'tool-result'
      id: string
      name?: string
      output: string
      isError?: boolean
    }
  | {
      type: 'end'
      outcome: 'ok' | 'error'
      turns?: number
      usage?: AgentUsage
      costUsd?: number
      error?: string
    }

/** A transcript entry with the time it was written, one JSONL line. */
export type TranscriptLine = TranscriptEntry & { at: string }

/** Where an adapter writes the events of a run. Writing never throws into the run. */
export interface TranscriptSink {
  write(entry: TranscriptEntry): void
}

/** A sink that keeps the run's lines in memory and serializes them as JSONL. */
export interface Transcript extends TranscriptSink {
  lines(): TranscriptLine[]
  /** One JSON object per line, newline-terminated. */
  toJsonl(): string
}

/** Characters a tool result or a tool call argument keeps in a transcript. */
export const TRANSCRIPT_TEXT_LIMIT = 4000

const REDACTED = '[redacted]'

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk-ant-|sk-|glpat-|gldt-|ghp_|gho_|ghs_|github_pat_|xox[abpr]-)[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
]

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit)}… [${text.length - limit} more characters]`

/** `text` with every secret value and well-known token shape replaced by `[redacted]`. */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const secret of secrets) if (secret.length >= 8) out = out.replaceAll(secret, REDACTED)
  for (const pattern of SECRET_PATTERNS)
    out = out.replace(pattern, (match, scheme: unknown) =>
      typeof scheme === 'string' && /^(Bearer|Basic)$/.test(scheme)
        ? `${scheme} ${REDACTED}`
        : REDACTED,
    )
  return out
}

function scrub(value: unknown, secrets: readonly string[], limit: number): unknown {
  if (typeof value === 'string') return clip(redactText(value, secrets), limit)
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets, limit))
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrub(item, secrets, limit)]),
    )
  return value
}

/**
 * `entry` as it may be stored: secrets and token shapes redacted everywhere, tool results and
 * tool call arguments cut at `limit` characters. The prompt and system prompt are redacted but
 * kept whole.
 */
export function sanitizeEntry(
  entry: TranscriptEntry,
  secrets: readonly string[] = [],
  limit = TRANSCRIPT_TEXT_LIMIT,
): TranscriptEntry {
  if (entry.type === 'start')
    return {
      ...entry,
      prompt: redactText(entry.prompt, secrets),
      ...(entry.system !== undefined && { system: redactText(entry.system, secrets) }),
    }
  if (entry.type === 'assistant')
    return {
      type: 'assistant',
      ...(entry.text !== undefined && { text: redactText(entry.text, secrets) }),
      ...(entry.reasoning !== undefined && {
        reasoning: clip(redactText(entry.reasoning, secrets), limit),
      }),
      ...(entry.toolCalls && {
        toolCalls: entry.toolCalls.map((call) => ({
          ...call,
          input: scrub(call.input, secrets, limit),
        })),
      }),
    }
  if (entry.type === 'tool-result')
    return { ...entry, output: clip(redactText(entry.output, secrets), limit) }
  return entry.error === undefined ? entry : { ...entry, error: redactText(entry.error, secrets) }
}

/** `sink` that redacts `secrets` (and token shapes) from every entry before passing it on. */
export function redactingSink(sink: TranscriptSink, secrets: readonly string[]): TranscriptSink {
  const values = secrets.filter((secret) => secret.length >= 8)
  return { write: (entry) => sink.write(sanitizeEntry(entry, values)) }
}

/**
 * An in-memory transcript. Entries are sanitized on write (`sanitizeEntry` with `secrets`), so
 * nothing secret is ever held, and stamped with `now()`.
 */
export function createTranscript(
  options: { secrets?: readonly string[]; limit?: number; now?: () => Date } = {},
): Transcript {
  const { secrets = [], limit = TRANSCRIPT_TEXT_LIMIT, now = () => new Date() } = options
  const lines: TranscriptLine[] = []
  return {
    write(entry) {
      try {
        lines.push({ at: now().toISOString(), ...sanitizeEntry(entry, secrets, limit) })
      } catch {
        // A transcript is diagnostics; it must never fail the run it describes.
      }
    },
    lines: () => lines.map((line) => structuredClone(line)),
    toJsonl: () => lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
  }
}

const ENTRY_TYPES: ReadonlySet<unknown> = new Set(['start', 'assistant', 'tool-result', 'end'])

const isTranscriptLine = (value: unknown): value is TranscriptLine =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  ENTRY_TYPES.has(value.type) &&
  'at' in value &&
  typeof value.at === 'string'

/** Lines of a JSONL transcript; malformed lines are skipped. */
export function parseTranscript(jsonl: string): TranscriptLine[] {
  return jsonl.split('\n').flatMap((line) => {
    if (!line.trim()) return []
    try {
      const value: unknown = JSON.parse(line)
      return isTranscriptLine(value) ? [value] : []
    } catch {
      return []
    }
  })
}
