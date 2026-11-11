import { mapModel, parseProviderOptions, renderHeaders, type AiProvider } from './provider.ts'
import { redactText } from './transcript.ts'

/** What `probeAgentLoop` found. */
export interface AgentLoopProbe {
  status: 'ok' | 'failed'
  /** The provider's model name the probe asked. */
  model: string
  latencyMs: number
  /** Why it failed, with the secret redacted. */
  error?: string
  /**
   * The provider answered whether it serves the loop: a successful answer, or a 400 that rejects
   * the request (tools, `cache_control`). Transport errors, timeouts, 401/403, 429 and 5xx say
   * nothing about the loop, so callers keep the result they had.
   */
  conclusive: boolean
}

const PROBE_TOOL = 'record_word'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Asks an Anthropic or Anthropic-compatible provider one tiny Messages request with a tool, a
 * cache breakpoint on the system prompt and `tool_choice: auto` (Claude 5.5 models refuse forced
 * tool use), the way the Claude Agent SDK loop talks to it. `ok` when the answer calls the tool;
 * `failed` with the reason on an HTTP error, a timeout, a malformed answer or no tool call, and
 * `conclusive` only when the answer decides it (see `AgentLoopProbe`). `model` is a logical id; the provider's `modelMap` applies. Never throws for provider failures; throws for
 * an `ai-sdk` provider, which this probe does not apply to.
 */
export async function probeAgentLoop(
  provider: AiProvider,
  model: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<AgentLoopProbe> {
  const parsed = parseProviderOptions(provider)
  if (parsed.kind === 'ai-sdk') throw new Error('only Anthropic Messages providers can be probed')
  const modelId = mapModel(model, parsed.modelMap)
  const root = (parsed.baseUrl ?? provider.url).replace(/\/+$/, '').replace(/\/v1$/, '')
  const bearer = parsed.kind === 'anthropic-compatible' && parsed.authHeader === 'bearer'
  const custom =
    parsed.kind === 'anthropic-compatible' ? renderHeaders(parsed.headers, provider.secret) : {}
  const secrets = [provider.secret, ...Object.values(custom)]
  const started = Date.now()
  const failed = (error: string, conclusive: boolean): AgentLoopProbe => ({
    status: 'failed',
    model: modelId,
    latencyMs: Date.now() - started,
    error: redactText(error, secrets),
    conclusive,
  })
  try {
    const response = await (options.fetch ?? fetch)(`${root}/v1/messages`, {
      method: 'POST',
      headers: {
        ...custom,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(bearer
          ? { authorization: `Bearer ${provider.secret}` }
          : { 'x-api-key': provider.secret }),
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 128,
        system: [
          {
            type: 'text',
            text: 'You check that tools work. Use the tool you are asked to use.',
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [
          {
            name: PROBE_TOOL,
            description: 'Records one word.',
            input_schema: {
              type: 'object',
              properties: { word: { type: 'string' } },
              required: ['word'],
            },
          },
        ],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: `Call ${PROBE_TOOL} with the word "ok".` }],
      }),
      ...(options.signal && { signal: options.signal }),
    })
    const body: unknown = await response.json().catch(() => undefined)
    const record: Record<string, unknown> =
      typeof body === 'object' && body !== null && !Array.isArray(body) ? { ...body } : {}
    if (!response.ok) {
      const error = record['error']
      const message =
        typeof error === 'object' && error !== null && 'message' in error
          ? String(error.message)
          : response.statusText
      return failed(
        `HTTP ${response.status}${message ? `: ${message}` : ''}`,
        response.status === 400,
      )
    }
    const content = Array.isArray(record['content']) ? record['content'] : undefined
    if (!content) return failed('the answer is not a Messages response', true)
    const called = content.some(
      (block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_use' &&
        'name' in block &&
        block.name === PROBE_TOOL,
    )
    if (!called) return failed('the model answered without calling the tool', true)
    return { status: 'ok', model: modelId, latencyMs: Date.now() - started, conclusive: true }
  } catch (error) {
    return failed(errorText(error), false)
  }
}
