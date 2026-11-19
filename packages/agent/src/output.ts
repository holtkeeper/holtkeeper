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

/** Names models give a tool they make up to hand in the answer. */
const ANSWER_NAME = /json|answer|final|result|submit|respond|response|output|report|review/i

const isObject = (value: unknown): value is Record<string, unknown> | unknown[] =>
  typeof value === 'object' && value !== null

/**
 * What a call of a tool that does not exist says about the answer of a task that wants `schema`:
 * `{ answer }` when the call's arguments, or one of their fields (given as a value or as JSON
 * text), match the schema; `{ problem }` naming the mismatches when they hold a JSON object or
 * array that does not and the tool's name says it was meant for the answer (`ANSWER_NAME`);
 * `undefined` otherwise, so the call is an ordinary unknown-tool error.
 */
export function answerInToolCall(
  toolName: string,
  input: string,
  schema: z.ZodType,
): { answer: unknown } | { problem: string } | undefined {
  let args: unknown
  try {
    args = JSON.parse(input || '{}')
  } catch {
    return undefined
  }
  const fields = isObject(args) && !Array.isArray(args) ? Object.values(args) : []
  const nested = fields.flatMap((field) => {
    if (isObject(field)) return [field]
    if (typeof field !== 'string') return []
    try {
      const value: unknown = JSON.parse(field)
      return isObject(value) ? [value] : []
    } catch {
      return []
    }
  })
  const found = [args, ...nested].filter(
    (value) => isObject(value) && (Array.isArray(value) || Object.keys(value).length > 0),
  )
  for (const candidate of found)
    if (schema.safeParse(candidate).success) return { answer: candidate }
  if (!found.length || !ANSWER_NAME.test(toolName)) return undefined
  const issuesOf = (value: unknown) => schema.safeParse(value).error?.issues.length ?? 0
  const closest = found.toSorted((one, other) => issuesOf(one) - issuesOf(other))[0]
  try {
    validateAgentOutput(closest, schema)
  } catch (error) {
    if (error instanceof AgentOutputError)
      return {
        problem: `${toolName} is not a tool and there is no tool for the answer. What you passed was read as your answer, but the ${error.message}. Write the corrected JSON value as the text of your final message.`,
      }
  }
  return undefined
}
