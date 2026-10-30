import type { LifecycleCycle } from './types.ts'

/** Where latest versions and lifecycles come from. Every method answers `undefined` when it does not know. */
export interface VersionSources {
  /** Release lines of an endoflife.date product, newest first. */
  lifecycle(product: string): Promise<LifecycleCycle[] | undefined>
  /** `dist-tags.latest` of an npm package. */
  npm(name: string): Promise<string | undefined>
  /** Latest release of a PyPI package. */
  pypi(name: string): Promise<string | undefined>
  /** Tags of an image, e.g. `docker.io` + `library/nginx`; registries may return only the newest ones. */
  imageTags(registry: string, repository: string): Promise<string[] | undefined>
}

export interface HttpSourcesOptions {
  /** Default `globalThis.fetch`. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  /** Default `https://endoflife.date`. */
  endoflifeUrl?: string
  /** Default `https://registry.npmjs.org`. */
  npmUrl?: string
  /** Default `https://pypi.org`. */
  pypiUrl?: string
  /** Default `https://hub.docker.com`. */
  dockerHubUrl?: string
  /** Pages of 100 tags read from Docker Hub, newest first. Default 3. */
  dockerHubPages?: number
  /** Pages of 1000 tags read from other registries, which list tags in lexical order. Default 10. */
  registryPages?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
const dateOrFlag = (value: unknown) =>
  typeof value === 'string' || typeof value === 'boolean' ? value : undefined

/** Reads one endoflife.date cycle; `undefined` when it has no cycle name. */
export function parseCycle(value: unknown): LifecycleCycle | undefined {
  if (!isRecord(value)) return undefined
  const cycle =
    text(value.cycle) ?? (typeof value.cycle === 'number' ? String(value.cycle) : undefined)
  if (!cycle) return undefined
  const lts = dateOrFlag(value.lts)
  const latest = text(value.latest)
  const releaseDate = text(value.releaseDate)
  return {
    cycle,
    eol: dateOrFlag(value.eol) ?? false,
    ...(releaseDate ? { releaseDate } : {}),
    ...(lts !== undefined && lts !== false ? { lts } : {}),
    ...(latest ? { latest } : {}),
  }
}

/** Remembers each key's answer; a failed load answers `undefined`. */
const memo = <T>() => {
  const cache = new Map<string, Promise<T | undefined>>()
  return (key: string, load: () => Promise<T | undefined>) => {
    let pending = cache.get(key)
    if (!pending) {
      pending = load().catch(() => undefined)
      cache.set(key, pending)
    }
    return pending
  }
}

/** The `Bearer` challenge of a registry: where to get an anonymous token for `scope`. */
function challenge(header: string | null) {
  if (!header?.toLowerCase().startsWith('bearer ')) return undefined
  const fields = new Map(
    [...header.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1] ?? '', match[2] ?? '']),
  )
  const realm = fields.get('realm')
  return realm ? { realm, service: fields.get('service'), scope: fields.get('scope') } : undefined
}

/**
 * Sources backed by endoflife.date, the npm registry, PyPI, Docker Hub and the OCI distribution API
 * (anonymous tokens) for other registries. Answers are cached for the lifetime of the instance, so
 * create one per run; failed lookups resolve to `undefined`.
 */
export function createHttpSources(options: HttpSourcesOptions = {}): VersionSources {
  const {
    fetch: get = globalThis.fetch,
    endoflifeUrl = 'https://endoflife.date',
    npmUrl = 'https://registry.npmjs.org',
    pypiUrl = 'https://pypi.org',
    dockerHubUrl = 'https://hub.docker.com',
    dockerHubPages = 3,
    registryPages = 10,
  } = options
  const cycles = memo<LifecycleCycle[]>()
  const versions = memo<string>()
  const tagLists = memo<string[]>()
  const json = async (url: string, init?: RequestInit): Promise<unknown> => {
    const response = await get(url, init)
    return response.ok ? response.json() : undefined
  }

  const hubTags = async (repository: string) => {
    const tags: string[] = []
    let url: string | undefined =
      `${dockerHubUrl}/v2/repositories/${repository}/tags?page_size=100&ordering=last_updated`
    for (let page = 0; url && page < dockerHubPages; page++) {
      // oxlint-disable-next-line no-await-in-loop -- pages follow `next` links
      const body = await json(url)
      if (!isRecord(body)) break
      for (const entry of Array.isArray(body.results) ? body.results : [])
        if (isRecord(entry) && typeof entry.name === 'string') tags.push(entry.name)
      url = text(body.next)
    }
    return tags.length ? tags : undefined
  }

  const registryTags = async (registry: string, repository: string) => {
    let url: string | undefined = `https://${registry}/v2/${repository}/tags/list?n=1000`
    let headers: Record<string, string> = {}
    const tags: string[] = []
    for (let page = 0; url && page < registryPages; page++) {
      // oxlint-disable-next-line no-await-in-loop -- pages follow `Link` headers
      let response = await get(url, { headers })
      const auth =
        response.status === 401 ? challenge(response.headers.get('www-authenticate')) : undefined
      if (auth) {
        const params = new URLSearchParams({
          ...(auth.service ? { service: auth.service } : {}),
          scope: auth.scope ?? `repository:${repository}:pull`,
        })
        // oxlint-disable-next-line no-await-in-loop -- one token per run, on the first page
        const token = await json(`${auth.realm}?${params.toString()}`)
        const bearer = isRecord(token) ? (text(token.token) ?? text(token.access_token)) : undefined
        if (!bearer) return undefined
        headers = { authorization: `Bearer ${bearer}` }
        // oxlint-disable-next-line no-await-in-loop -- retries the same page with the token
        response = await get(url, { headers })
      }
      if (!response.ok) break
      // oxlint-disable-next-line no-await-in-loop -- pages follow `Link` headers
      const body: unknown = await response.json()
      if (isRecord(body) && Array.isArray(body.tags))
        for (const tag of body.tags) if (typeof tag === 'string') tags.push(tag)
      const next = /<([^>]+)>;\s*rel="?next"?/.exec(response.headers.get('link') ?? '')?.[1]
      url = next ? new URL(next, url).toString() : undefined
    }
    return tags.length ? tags : undefined
  }

  return {
    lifecycle: (product) =>
      cycles(`eol:${product}`, async () => {
        const body = await json(`${endoflifeUrl}/api/${product}.json`)
        if (!Array.isArray(body)) return undefined
        const parsed = body.map(parseCycle).filter((cycle) => cycle !== undefined)
        return parsed.length ? parsed : undefined
      }),
    npm: (name) =>
      versions(`npm:${name}`, async () => {
        const body = await json(`${npmUrl}/${name.replace('/', '%2f')}`, {
          headers: { accept: 'application/vnd.npm.install-v1+json' },
        })
        const tags = isRecord(body) ? body['dist-tags'] : undefined
        return isRecord(tags) ? text(tags.latest) : undefined
      }),
    pypi: (name) =>
      versions(`pypi:${name}`, async () => {
        const body = await json(`${pypiUrl}/pypi/${name}/json`)
        const info = isRecord(body) ? body.info : undefined
        return isRecord(info) ? text(info.version) : undefined
      }),
    imageTags: (registry, repository) =>
      tagLists(`image:${registry}/${repository}`, () =>
        registry === 'docker.io' ? hubTags(repository) : registryTags(registry, repository),
      ),
  }
}
