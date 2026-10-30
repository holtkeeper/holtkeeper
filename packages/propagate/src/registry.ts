import type { Ecosystem, PackageRequest, PackageTarget, VersionRegistry } from './types.ts'

export interface HttpRegistryOptions {
  /** Default `globalThis.fetch`. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  /** Default `https://registry.npmjs.org`. */
  npmUrl?: string
  /** Default `https://proxy.golang.org`. */
  goProxyUrl?: string
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined

/** Go module proxy escaping: upper-case letters become `!` + lower case. */
const escapeModulePath = (path: string) =>
  path.replace(/[A-Z]/g, (char) => `!${char.toLowerCase()}`)

/**
 * Latest versions from the npm registry (`dist-tags.latest`) and the Go module proxy (`@latest`).
 * Answers are cached per instance; failed lookups resolve to `undefined`.
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
    return response.ok ? response.json() : undefined
  }
  const lookup = async (ecosystem: Ecosystem, name: string) => {
    if (ecosystem === 'npm') {
      const body = await json(`${npmUrl}/${name.replace('/', '%2f')}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
      })
      const latest = field(field(body, 'dist-tags'), 'latest')
      return typeof latest === 'string' ? latest : undefined
    }
    const version = field(await json(`${goProxyUrl}/${escapeModulePath(name)}/@latest`), 'Version')
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

/**
 * Resolves requested versions: `latest` through `registry`, exact ones as given. npm versions lose
 * a leading `v`, Go versions gain one. Rejects when `latest` cannot be resolved.
 */
export async function resolveTargets(
  packages: PackageRequest[],
  registry?: VersionRegistry,
): Promise<PackageTarget[]> {
  return Promise.all(
    packages.map(async ({ name, version, ecosystem = 'npm' }) => {
      let resolved = version
      if (version === 'latest') {
        const latest = await registry?.latest(ecosystem, name)
        if (!latest) throw new Error(`cannot resolve the latest version of ${name}`)
        resolved = latest
      }
      resolved = ecosystem === 'Go' ? `v${resolved.replace(/^v/, '')}` : resolved.replace(/^v/, '')
      return { name, ecosystem, requested: version, version: resolved }
    }),
  )
}
