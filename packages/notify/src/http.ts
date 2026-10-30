import type { Fetch } from './types.ts'

export interface PostOptions {
  /** Notifier name, used in error messages instead of the secret URL. */
  name: string
  url: string
  body: string
  headers: Record<string, string>
  fetch: Fetch
  sleep: (ms: number) => Promise<void>
  signal?: AbortSignal
}

const retryable = (status: number) => status === 429 || status >= 500

/** Waits the `Retry-After` seconds the server asked for, 1 s by default and 30 s at most. */
function retryDelay(response: Response): number {
  const seconds = Number(response.headers.get('retry-after'))
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 30) * 1000 : 1000
}

/** Removes every occurrence of the given secrets from a message. */
export function redact(message: string, secrets: string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((text, secret) => text.replaceAll(secret, '<redacted>'), message)
}

/**
 * POSTs `body` and retries once on 429 or 5xx. Rejects on any other non-2xx status or a network
 * failure; error messages name the notifier and status but never the URL or header values.
 */
export async function post(options: PostOptions): Promise<void> {
  const { name, url, body, headers, fetch, sleep, signal } = options
  const secrets = [url, ...Object.values(headers)]
  const attempt = async () => {
    try {
      return await fetch(url, { method: 'POST', headers, body, ...(signal ? { signal } : {}) })
    } catch (error) {
      const reason = redact(error instanceof Error ? error.message : String(error), secrets)
      // oxlint-disable-next-line preserve-caught-error -- the cause may carry the secret URL
      throw new Error(`${name}: request failed: ${reason}`)
    }
  }
  let response = await attempt()
  if (retryable(response.status)) {
    await response.body?.cancel()
    await sleep(retryDelay(response))
    response = await attempt()
  }
  if (!response.ok) {
    const text = redact((await response.text().catch(() => '')).slice(0, 200), secrets)
    throw new Error(`${name}: HTTP ${response.status}${text ? `: ${text}` : ''}`)
  }
  await response.body?.cancel()
}

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
