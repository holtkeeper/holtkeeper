const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers })

interface FakePage {
  id: string
  title: string
  version: number
  body: string
  status?: string
}

interface FakeRequest {
  method: string
  path: string
  search: string
  authorization: string | null
  body: unknown
}

export interface FakeConfluence {
  url: string
  pages: Map<string, FakePage>
  requests: FakeRequest[]
  /** Answers the next request with this status and JSON body instead of handling it. */
  failNext(status: number, body: unknown, headers?: Record<string, string>): void
  /** Bumps a page's version right before the next PUT is handled, as a concurrent editor would. */
  raceNextPut(id: string): void
  stop(): Promise<void>
}

/**
 * A local Confluence speaking Cloud REST v2 (`/wiki/api/v2/pages/:id`) or Data Center REST v1
 * (`/confluence/rest/api/content/:id`), checking the Authorization header and page versions.
 */
export function startFakeConfluence(
  flavor: 'cloud' | 'datacenter',
  authorization: string,
): FakeConfluence {
  const pages = new Map<string, FakePage>()
  const requests: FakeRequest[] = []
  const failures: { status: number; body: unknown; headers?: Record<string, string> }[] = []
  const races = new Set<string>()
  const prefix = flavor === 'cloud' ? '/wiki/api/v2/pages/' : '/confluence/rest/api/content/'

  const error = (status: number, message: string) =>
    flavor === 'cloud'
      ? json(status, { errors: [{ status, code: 'ERR', title: message, detail: null }] })
      : json(status, { statusCode: status, message })

  const render = (page: FakePage, origin: string) =>
    flavor === 'cloud'
      ? {
          id: page.id,
          status: page.status ?? 'current',
          title: page.title,
          version: { number: page.version, message: '' },
          body: { storage: { representation: 'storage', value: page.body } },
          _links: { webui: `/spaces/ENG/pages/${page.id}/${page.title}`, base: `${origin}/wiki` },
        }
      : {
          id: page.id,
          type: 'page',
          status: page.status ?? 'current',
          title: page.title,
          version: { number: page.version },
          body: { storage: { value: page.body, representation: 'storage' } },
          _links: { webui: `/display/ENG/${page.title}`, base: `${origin}/confluence` },
        }

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const text = await request.text()
      const body: unknown = text ? JSON.parse(text) : undefined
      requests.push({
        method: request.method,
        path: url.pathname,
        search: url.search,
        authorization: request.headers.get('authorization'),
        body,
      })
      const failure = failures.shift()
      if (failure) return json(failure.status, failure.body, failure.headers)
      if (request.headers.get('authorization') !== authorization) return error(401, 'Unauthorized')
      if (!url.pathname.startsWith(prefix)) return error(404, 'No route')
      const id = url.pathname.slice(prefix.length)
      const page = pages.get(id)
      if (!page) return error(404, `No content with id ${id}`)

      if (request.method === 'GET') {
        const wanted =
          flavor === 'cloud'
            ? url.searchParams.get('body-format') === 'storage'
            : url.searchParams.get('expand') === 'body.storage,version'
        if (!wanted) return error(400, 'body not requested')
        return json(200, render(page, url.origin))
      }
      if (request.method === 'PUT') {
        if (races.delete(id)) page.version++
        const update = body as {
          id: string
          title: string
          status: string
          version: { number: number; message?: string }
          body: {
            representation?: string
            value?: string
            storage?: { value: string; representation: string }
          }
        }
        const value = flavor === 'cloud' ? update.body.value : update.body.storage?.value
        const representation =
          flavor === 'cloud' ? update.body.representation : update.body.storage?.representation
        if (
          update.id !== id ||
          update.status !== 'current' ||
          !update.title ||
          representation !== 'storage' ||
          value === undefined
        )
          return error(400, 'bad update')
        if (update.version.number !== page.version + 1)
          return error(409, 'Version must be incremented')
        page.version = update.version.number
        page.body = value
        page.title = update.title
        return json(200, render(page, url.origin))
      }
      return error(405, 'Method not allowed')
    },
  })

  const origin = `http://localhost:${server.port}`
  return {
    url: flavor === 'cloud' ? origin : `${origin}/confluence`,
    pages,
    requests,
    failNext(status, body, headers) {
      failures.push({ status, body, ...(headers ? { headers } : {}) })
    },
    raceNextPut(id) {
      races.add(id)
    },
    stop: () => server.stop(true),
  }
}
