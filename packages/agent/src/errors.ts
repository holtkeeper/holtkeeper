import type { AgentUsage } from './types.ts'

/**
 * A spend limit stopped the run: the provider or gateway refused because a budget, quota or
 * balance is used up, the run reached its own `maxCostUsd`, or a budget denied it before it
 * started. Retrying does not help until the limit resets or is raised, unlike a rate limit. When
 * the run had started, `usage`, `costUsd` and `turns` say what it used.
 */
export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError'
  /** HTTP status of the refusal, when it came over HTTP. */
  readonly httpStatus: number | undefined
  /** Error code the provider sent, e.g. `insufficient_funds`, when there was one. */
  readonly code: string | undefined
  readonly usage: AgentUsage | undefined
  readonly costUsd: number | undefined
  readonly turns: number | undefined

  constructor(
    message: string,
    details: {
      httpStatus?: number
      code?: string
      cause?: unknown
      usage?: AgentUsage
      costUsd?: number
      turns?: number
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.httpStatus = details.httpStatus
    this.code = details.code
    this.usage = details.usage
    this.costUsd = details.costUsd
    this.turns = details.turns
  }
}

const BUDGET_CODES =
  /\b(api_key_limit_exceeded|insufficient_funds|insufficient_quota|insufficient_credits|budget_exceeded|spend_limit_exceeded|billing_hard_limit_reached)\b/

const BUDGET_TEXT =
  /budget (has been |is )?exceeded|exceeded (your |the )?(budget|spend|current quota)|spend(ing)? limit|credit balance is too low|insufficient (funds|credits|balance|quota)|key limit exceeded/i

const BUDGET_STATUSES = new Set([400, 403, 429])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const numberField = (value: unknown, key: string) => {
  const field = isRecord(value) ? value[key] : undefined
  return typeof field === 'number' ? field : undefined
}

const stringField = (value: unknown, key: string) => {
  const field = isRecord(value) ? value[key] : undefined
  return typeof field === 'string' ? field : undefined
}

function refusalOf(
  status: number | undefined,
  text: string,
  cause: unknown,
): BudgetExceededError | undefined {
  const code = BUDGET_CODES.exec(text)?.[1]
  const budget =
    status === 402 ||
    code !== undefined ||
    ((status === undefined || BUDGET_STATUSES.has(status)) && BUDGET_TEXT.test(text))
  if (!budget) return undefined
  const detail = text.replace(/\s+/g, ' ').trim().slice(0, 300)
  return new BudgetExceededError(
    `AI budget exceeded${status === undefined ? '' : ` (HTTP ${status})`}${detail ? `: ${detail}` : ''}`,
    {
      ...(status !== undefined && { httpStatus: status }),
      ...(code !== undefined && { code }),
      cause,
    },
  )
}

/**
 * `error` as a `BudgetExceededError` when it is a provider or gateway refusal over a spent limit:
 * HTTP 402, a known budget error code in the body (`insufficient_funds`,
 * `api_key_limit_exceeded`, `insufficient_quota`, ...), or a 400/403/429 whose message speaks of a
 * spend limit, budget or credit balance. Reads AI SDK `APICallError` and `RetryError` shapes
 * (`statusCode`, `responseBody`, `lastError`, `cause`). `undefined` for anything else, rate
 * limits included.
 */
export function budgetExceededFrom(error: unknown): BudgetExceededError | undefined {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (isRecord(current) && !seen.has(current)) {
    if (current instanceof BudgetExceededError) return current
    seen.add(current)
    const status = numberField(current, 'statusCode') ?? numberField(current, 'status')
    const text = [stringField(current, 'message'), stringField(current, 'responseBody')]
      .filter(Boolean)
      .join(' ')
    const refusal = refusalOf(status, text, error)
    if (refusal) return refusal
    current = current['lastError'] ?? current['cause']
  }
  return undefined
}
