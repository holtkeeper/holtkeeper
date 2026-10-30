import type { ForgeFetch } from '@holtkeeper/forge'
import { gitlab } from '@holtkeeper/forge-gitlab'
import type { ConfigDocument } from '@holtkeeper/store'

import type { ForgeFactory } from './effective.ts'

/**
 * The `gitlab` forge factory: `gitlab({ url, token })` from `@holtkeeper/forge-gitlab`, with the
 * `fetch` from `fetchFor` when given (e.g. one wrapped with shared rate limits).
 */
export function gitlabForgeFactory(
  options: { fetchFor?: (doc: ConfigDocument<'forge'>) => ForgeFetch } = {},
): ForgeFactory {
  return (doc, token) =>
    gitlab({
      url: doc.data.url,
      token,
      ...(options.fetchFor && { fetch: options.fetchFor(doc) }),
    })
}
