import type { Ecosystem } from './types.ts'

/** Where latest library versions come from. Implementations answer `undefined` for unknown libraries. */
export interface VersionRegistry {
  latest(ecosystem: Ecosystem, name: string): Promise<string | undefined>
}

export interface HttpRegistryOptions {
  /** Default `globalThis.fetch`. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  /** Default `https://registry.npmjs.org`. */
  npmUrl?: string
  /** Default `https://proxy.golang.org`. */
  goProxyUrl?: string
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined

/** Go module proxy path escaping: upper-case letters become `!` + lower case. */
export const escapeModulePath = (path: string) =>
  path.replace(/[A-Z]/g, (char) => `!${char.toLowerCase()}`)

/**
 * Registry backed by the npm registry and the Go module proxy. Answers are cached for the
 * lifetime of the instance, so create one per run. Failed lookups resolve to `undefined`.
 */
export function createHttpRegistry(options: HttpRegistryOptions = {}): VersionRegistry {
  const {
    fetch: get = globalThis.fetch,
    npmUrl = 'https://registry.npmjs.org',
    goProxyUrl = 'https://proxy.golang.org',
  } = options
  const cache = new Map<string, Promise<string | undefined>>()

  const json = async (url: string, init?: RequestInit): Promise<unknown> => {
    const response = await get(url, init)
    if (!response.ok) return undefined
    return response.json()
  }

  const lookup = async (ecosystem: Ecosystem, name: string) => {
    if (ecosystem === 'npm') {
      const body = await json(`${npmUrl}/${name.replace('/', '%2f')}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
      })
      const tags = field(body, 'dist-tags')
      const latest = field(tags, 'latest')
      return typeof latest === 'string' ? latest : undefined
    }
    const body = await json(`${goProxyUrl}/${escapeModulePath(name)}/@latest`)
    const version = field(body, 'Version')
    return typeof version === 'string' ? version : undefined
  }

  return {
    latest(ecosystem, name) {
      const key = `${ecosystem}:${name}`
      let pending = cache.get(key)
      if (!pending) {
        pending = lookup(ecosystem, name).catch(() => undefined)
        cache.set(key, pending)
      }
      return pending
    },
  }
}
