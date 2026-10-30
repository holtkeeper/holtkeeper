import type { FetchLike } from '../src/http.ts'

interface FakeKey {
  id: number
  title: string
  key: string
  created_at: string
  expires_at: string | null
  usage_type?: string
}

interface DeployLink {
  can_push: boolean
}

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

/** An in-memory GitLab answering only the SSH key endpoints, as GitLab REST v4 documents them. */
export class FakeGitLabKeys {
  readonly base = 'https://gitlab.test'
  readonly token = 'glpat-keys'
  readonly calls: { method: string; path: string; body: unknown }[] = []
  readonly userKeys = new Map<number, FakeKey>()
  readonly deployKeys = new Map<number, FakeKey>()
  /** Deploy key id → project path → link. */
  readonly enabled = new Map<number, Map<string, DeployLink>>()
  readonly projects = new Set(['games/a', 'games/b'])
  private nextId = 1

  readonly fetch: FetchLike = async (input, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    if (headers['PRIVATE-TOKEN'] !== this.token) return json(401, { message: '401 Unauthorized' })
    const method = init.method ?? 'GET'
    const url = new URL(input)
    const path = url.pathname.replace(/^\/api\/v4\//, '')
    const body =
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    this.calls.push({ method, path: decodeURIComponent(path), body })
    return this.route(method, path.split('/').map(decodeURIComponent), body)
  }

  private create(body: Record<string, unknown>): FakeKey | Response {
    if (typeof body['title'] !== 'string' || typeof body['key'] !== 'string')
      return json(400, { error: 'title, key are missing' })
    return {
      id: this.nextId++,
      title: body['title'],
      key: body['key'],
      created_at: '2026-10-30T00:00:00.000Z',
      expires_at: typeof body['expires_at'] === 'string' ? body['expires_at'] : null,
    }
  }

  private route(method: string, s: string[], body: Record<string, unknown>): Response {
    if (s[0] === 'user' && s[1] === 'keys') {
      if (method === 'GET' && s.length === 2) return json(200, [...this.userKeys.values()])
      if (method === 'POST' && s.length === 2) {
        const usage =
          typeof body['usage_type'] === 'string' ? body['usage_type'] : 'auth_and_signing'
        if (!['auth', 'signing', 'auth_and_signing'].includes(usage))
          return json(400, { error: 'usage_type does not have a valid value' })
        if ([...this.userKeys.values()].some((key) => key.key === body['key']))
          return json(400, { message: { fingerprint_sha256: ['has already been taken'] } })
        const key = this.create(body)
        if (key instanceof Response) return key
        key.usage_type = usage
        this.userKeys.set(key.id, key)
        return json(201, key)
      }
      if (method === 'DELETE' && s.length === 3) {
        return this.userKeys.delete(Number(s[2]))
          ? json(204, undefined)
          : json(404, { message: '404 Key Not Found' })
      }
    }
    if (s[0] === 'projects' && s[2] === 'deploy_keys') {
      const repo = s[1] ?? ''
      if (!this.projects.has(repo)) return json(404, { message: '404 Project Not Found' })
      const id = Number(s[3])
      const linked = (keyId: number) => this.enabled.get(keyId)?.get(repo)
      const view = (key: FakeKey) => ({ ...key, can_push: linked(key.id)?.can_push ?? false })
      if (method === 'GET' && s.length === 3)
        return json(200, [...this.deployKeys.values()].filter((key) => linked(key.id)).map(view))
      if (method === 'POST' && s.length === 3) {
        const existing = [...this.deployKeys.values()].find((key) => key.key === body['key'])
        const key = existing ?? this.create(body)
        if (key instanceof Response) return key
        this.deployKeys.set(key.id, key)
        const links = this.enabled.get(key.id) ?? new Map<string, DeployLink>()
        links.set(repo, { can_push: body['can_push'] === true })
        this.enabled.set(key.id, links)
        return json(201, view(key))
      }
      const key = this.deployKeys.get(id)
      if (!key) return json(404, { message: '404 Deploy Key Not Found' })
      if (method === 'POST' && s[4] === 'enable') {
        const links = this.enabled.get(id) ?? new Map<string, DeployLink>()
        if (!links.has(repo)) links.set(repo, { can_push: false })
        this.enabled.set(id, links)
        return json(201, view(key))
      }
      if (method === 'PUT' && s.length === 4) {
        const link = linked(id)
        if (!link) return json(404, { message: '404 Deploy Key Not Found' })
        if (typeof body['can_push'] === 'boolean') link.can_push = body['can_push']
        return json(200, view(key))
      }
      if (method === 'DELETE' && s.length === 4) {
        if (!this.enabled.get(id)?.delete(repo))
          return json(404, { message: '404 Deploy Key Not Found' })
        if (this.enabled.get(id)?.size === 0) this.deployKeys.delete(id)
        return json(204, undefined)
      }
    }
    return json(404, { error: `404 Not Found (${method} ${s.join('/')})` })
  }
}
