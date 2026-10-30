import { json } from '@holtkeeper/auth'

import { HttpError, errorResponse } from './errors.ts'

type Handler<C> = (
  request: Request,
  params: Record<string, string>,
  context: C,
) => Promise<Response>

export interface Route<C> {
  method: string
  /** Segments starting with `:` capture one path segment. */
  pattern: string
  handler: Handler<C>
}

function match(pattern: string, path: string): Record<string, string> | undefined {
  const want = pattern.split('/')
  const got = path.split('/')
  if (want.length !== got.length) return undefined
  const params: Record<string, string> = {}
  for (const [index, segment] of want.entries()) {
    const actual = got[index] ?? ''
    if (segment.startsWith(':')) {
      if (!actual) return undefined
      try {
        params[segment.slice(1)] = decodeURIComponent(actual)
      } catch {
        return undefined
      }
    } else if (segment !== actual) return undefined
  }
  return params
}

/**
 * Dispatches to the first matching route. Unknown paths give `undefined`, a known path with
 * another method 405, and a thrown `HttpError` its JSON error response.
 */
export function createRouter<C>(routes: Route<C>[]) {
  return async (request: Request, path: string, context: C): Promise<Response | undefined> => {
    const matches = routes.flatMap((route) => {
      const params = match(route.pattern, path)
      return params ? [{ route, params }] : []
    })
    const found = matches.find(({ route }) => route.method === request.method)
    if (!found)
      return matches.length ? json({ error: 'method not allowed' }, { status: 405 }) : undefined
    try {
      return await found.route.handler(request, found.params, context)
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error)
      throw error
    }
  }
}
