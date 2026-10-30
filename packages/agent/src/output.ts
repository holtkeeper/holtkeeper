import type { z } from 'zod'

/** The agent's answer is not JSON or does not match the requested schema. */
export class AgentOutputError extends Error {
  override name = 'AgentOutputError'
  /** The raw answer, for logs. */
  readonly text: string

  constructor(message: string, text: string) {
    super(message)
    this.text = text
  }
}

const fence = /^```[\w-]*\s*\n([\s\S]*?)\n?```\s*$/

function candidates(text: string): string[] {
  const trimmed = text.trim()
  const found = [trimmed]
  const fenced = fence.exec(trimmed)?.[1]
  if (fenced !== undefined) found.push(fenced.trim())
  const inner = /```[\w-]*\s*\n([\s\S]*?)\n?```/.exec(trimmed)?.[1]
  if (inner !== undefined) found.push(inner.trim())
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = trimmed.indexOf(open)
    const end = trimmed.lastIndexOf(close)
    if (start !== -1 && end > start) found.push(trimmed.slice(start, end + 1))
  }
  return found
}

/**
 * Parses an agent's JSON answer and validates it against `schema`. Accepts bare JSON, JSON in a
 * Markdown code fence, or JSON surrounded by prose. Throws `AgentOutputError` when no JSON value
 * is found or the value does not match the schema.
 */
export function parseAgentOutput<Output>(text: string, schema: z.ZodType<Output>): Output {
  let value: unknown
  let parsed = false
  for (const candidate of candidates(text)) {
    try {
      value = JSON.parse(candidate)
      parsed = true
      break
    } catch {
      // try the next candidate
    }
  }
  if (!parsed) throw new AgentOutputError('agent answer is not valid JSON', text)
  return validateAgentOutput(value, schema, text)
}

/** Validates an already parsed answer; throws `AgentOutputError` listing the schema issues. */
export function validateAgentOutput<Output>(
  value: unknown,
  schema: z.ZodType<Output>,
  text = '',
): Output {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issues = result.error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ')
  throw new AgentOutputError(
    `agent answer does not match the expected shape: ${issues}`,
    text || JSON.stringify(value),
  )
}
