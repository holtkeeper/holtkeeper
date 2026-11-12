import type { RepoRef } from '@holtkeeper/forge'

/** A merge request a Slack message links. */
export interface MergeRequestLink {
  repo: RepoRef
  mergeRequest: number
  url: string
}

const urlPattern = /https?:\/\/[^\s<>|"]+/giu
const mergeRequestPath = /^\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#]|$)/u

const decode = (part: string) => {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/**
 * Merge requests of the given forges that Slack message text links, each once, in the order
 * they appear. Slack wraps links as `<url>` or `<url|label>` and escapes `&` as `&amp;`; both
 * forms and bare URLs are read. A URL counts when it starts with a forge's `url` and has a GitLab
 * merge request path (`<project>/-/merge_requests/<iid>`); other hosts and paths are ignored.
 */
export function mergeRequestLinks(
  text: string,
  forges: Readonly<Record<string, { url: string }>>,
): MergeRequestLink[] {
  const bases = Object.entries(forges).flatMap(([id, forge]) => {
    try {
      const base = new URL(forge.url)
      return [{ id, origin: base.origin.toLowerCase(), prefix: base.pathname.replace(/\/+$/, '') }]
    } catch {
      return []
    }
  })
  const found = new Map<string, MergeRequestLink>()
  for (const [raw] of text.matchAll(urlPattern)) {
    const href = raw.replaceAll('&amp;', '&').replace(/[.,;:!)\]]+$/u, '')
    let url: URL
    try {
      url = new URL(href)
    } catch {
      continue
    }
    for (const base of bases) {
      if (url.origin.toLowerCase() !== base.origin) continue
      if (base.prefix && !url.pathname.startsWith(`${base.prefix}/`)) continue
      const match = mergeRequestPath.exec(url.pathname.slice(base.prefix.length))
      if (!match?.[1] || !match[2]) continue
      const path = match[1].split('/').map(decode).join('/')
      const mergeRequest = Number(match[2])
      const key = `${base.id}:${path.toLowerCase()}!${mergeRequest}`
      if (!found.has(key))
        found.set(key, { repo: { forge: base.id, path }, mergeRequest, url: href })
      break
    }
  }
  return [...found.values()]
}
