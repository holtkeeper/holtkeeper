import type { LibraryChunk, LibraryRecord, LibrarySourceStatus } from '@holtkeeper/store'

import { documentChunks } from '../markdown.ts'

export interface SiteSourceOptions {
  fetch?: typeof fetch
  /** Pages fetched besides `robots.txt`, `llms.txt` and sitemaps. Default 200. */
  maxPages?: number
  /** Bytes read in all per library; fetching stops once reached. Default 5 MB. */
  maxBytes?: number
  /** Pause between two requests. Default 500 ms. */
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
}

/** Chunks of a library's docs site and the outcome of fetching it. */
export interface SiteDocs {
  chunks: Omit<LibraryChunk, 'versions'>[]
  status: LibrarySourceStatus
}

/** Fetches and chunks the docs site of one library; never throws for network or HTTP errors. */
export type SiteSource = (library: LibraryRecord, version?: string) => Promise<SiteDocs>

const userAgent = 'holtkeeper'
const maxChunk = 1500
const maxSitemaps = 20
const notDocsHosts = new Set([
  'github.com',
  'www.github.com',
  'gitlab.com',
  'bitbucket.org',
  'npmjs.com',
  'www.npmjs.com',
  'npmjs.org',
  'www.npmjs.org',
  'pkg.go.dev',
  'godoc.org',
])
const preferredPath = /(^|\/)(docs?|guides?|api|reference)(\/|$)/i

interface RobotsRule {
  allow: boolean
  pattern: string
}

/** Rules of `robots.txt` that apply to Holtkeeper: its own group if there is one, else `*`. */
export function parseRobots(text: string) {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = []
  const sitemaps: string[] = []
  let group: { agents: string[]; rules: RobotsRule[] } | undefined
  let lastWasAgent = false
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    const key = (match[1] ?? '').toLowerCase()
    const value = (match[2] ?? '').trim()
    if (key === 'sitemap') {
      if (value) sitemaps.push(value)
      continue
    }
    if (key === 'user-agent') {
      if (!group || !lastWasAgent) {
        group = { agents: [], rules: [] }
        groups.push(group)
      }
      group.agents.push(value.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!group || (key !== 'allow' && key !== 'disallow') || !value) continue
    group.rules.push({ allow: key === 'allow', pattern: value })
  }
  const own = groups.filter((g) => g.agents.some((agent) => agent.includes(userAgent)))
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes('*'))
  return { rules: chosen.flatMap((g) => g.rules), sitemaps }
}

const robotsPattern = (pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+?^{}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\\?\$$/, '$')}`,
  )

/** Whether `path` (with its query) may be fetched: the longest matching rule wins, ties allow. */
export function robotsAllows(rules: RobotsRule[], path: string) {
  let best: RobotsRule | undefined
  for (const rule of rules) {
    if (!robotsPattern(rule.pattern).test(path)) continue
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow)
    )
      best = rule
  }
  return best?.allow ?? true
}

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©',
  rarr: '→',
  larr: '←',
}

const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X'))
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16))
    if (body.startsWith('#')) return String.fromCodePoint(Number(body.slice(1)))
    return entities[body.toLowerCase()] ?? whole
  })

const stripTags = (html: string) => html.replace(/<[^>]*>/g, '')
const inline = (html: string) => decode(stripTags(html)).replace(/\s+/g, ' ').trim()

/**
 * Markdown-ish text of the main content of an HTML page: `<main>`, else `<article>`, else the body
 * without its header; navigation, footers and asides are dropped in every case. Keeps headings, lists, code blocks and inline
 * code; drops links, images and styling. Adds the `<title>` as a heading when the page has no
 * `<h1>`.
 */
export function htmlToMarkdown(html: string) {
  const title = inline(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
  let content = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, '')
  const main =
    /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(content)?.[1] ??
    /<article\b[^>]*>([\s\S]*)<\/article>/i.exec(content)?.[1]
  const chrome = main === undefined ? 'nav|header|footer|aside' : 'nav|footer|aside'
  content = main ?? /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(content)?.[1] ?? content
  const drop = new RegExp(`<(${chrome})\\b(?:(?!<\\1\\b)[\\s\\S])*?<\\/\\1\\s*>`, 'gi')
  for (let previous = ''; previous !== content;) {
    previous = content
    content = content.replace(drop, '')
  }
  const blocks: string[] = []
  content = content.replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi, (_, attributes: string, body) => {
    const lang =
      /language-([\w+-]+)/.exec(attributes)?.[1] ?? /language-([\w+-]+)/.exec(body)?.[1] ?? ''
    const code = decode(stripTags(String(body).replace(/<br\s*\/?>/gi, '\n'))).replace(/\n+$/, '')
    blocks.push(`\`\`\`${lang}\n${code}\n\`\`\``)
    return `\n\n\uE000${blocks.length - 1}\uE000\n\n`
  })
  content = content
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level: string, body: string) => {
      const text = inline(body).replace(/\s*[#¶]$/, '')
      return text ? `\n\n${'#'.repeat(Number(level))} ${text}\n\n` : ''
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, body: string) => {
      const text = inline(body)
      return text ? `\`${text}\`` : ''
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/?(p|blockquote|table|ul|ol|dl|section|figure)\b[^>]*>/gi, '\n\n')
    .replace(/<tr\b[^>]*>/gi, '\n| ')
    .replace(/<\/(td|th)\s*>/gi, ' | ')
    .replace(/<\/?(div|tr|br|hr|dt|dd|thead|tbody)\b[^>]*>/gi, '\n')
  const text = decode(stripTags(content))
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\uE000(\d+)\uE000/g, (_, index: string) => blocks[Number(index)] ?? '')
    .trim()
  return title && !/^# /m.test(text) ? `# ${title}\n\n${text}` : text
}

/** GitHub-style heading slug. */
export const headingSlug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .replace(/ /g, '-')

const splitLong = (text: string) => {
  if (text.length <= maxChunk) return [text]
  const pieces: string[] = []
  let current = ''
  let fenced = false
  const blocks: string[] = []
  let block = ''
  for (const line of text.split('\n')) {
    if (/^(```|~~~)/.test(line.trim())) fenced = !fenced
    if (!fenced && !line.trim() && block) {
      blocks.push(block)
      block = ''
    } else block += block ? `\n${line}` : line
  }
  if (block) blocks.push(block)
  for (const part of blocks) {
    if (current && current.length + part.length + 2 > maxChunk) {
      pieces.push(current)
      current = ''
    }
    if (part.length > maxChunk) {
      for (const line of part.split('\n')) {
        if (current && current.length + line.length + 1 > maxChunk) {
          pieces.push(current)
          current = ''
        }
        current += current ? `\n${line}` : line.slice(0, maxChunk)
      }
    } else current += current ? `\n\n${part}` : part
  }
  if (current) pieces.push(current)
  return pieces
}

/** Markdown split by headings into sections of at most about 1500 characters. */
export function splitSections(markdown: string) {
  const sections: { headings: string[]; text: string }[] = []
  const stack: string[] = []
  let lines: string[] = []
  let headings: string[] = []
  let fenced = false
  const flush = () => {
    const text = lines.join('\n').trim()
    const body = lines.filter((line) => !/^#{1,6}\s/.test(line)).join('\n')
    if (body.trim()) for (const piece of splitLong(text)) sections.push({ headings, text: piece })
    lines = []
  }
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const heading = fenced ? undefined : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      flush()
      const level = (heading[1] ?? '#').length
      stack.length = Math.min(stack.length, level - 1)
      while (stack.length < level - 1) stack.push('')
      stack.push(heading[2] ?? '')
      headings = stack.filter(Boolean)
    }
    lines.push(line)
  }
  flush()
  return sections
}

const looksLikeHtml = (text: string, contentType: string) =>
  contentType.includes('html') || /^\s*<(!doctype|html|head|body)\b/i.test(text)

interface Fetched {
  url: URL
  text: string
  contentType: string
}

/**
 * Docs site source: from `library.homepage` (GitHub, GitLab, npm and pkg.go.dev pages are not
 * docs sites), reads `llms-full.txt`, else `llms.txt` and the same-host pages it links, else
 * `sitemap.xml` pages (those under `/docs`, `/guide`, `/api` or `/reference` when there are
 * any), converting HTML to Markdown and chunking it by headings. Honours `robots.txt` for `*`
 * and `holtkeeper`, fetches one request at a time with a pause between, and stops at `maxPages`
 * pages or `maxBytes` bytes. The site is not versioned, so `version` is not used. Status is
 * `missing` when nothing usable was found, else `ok` with counts in `message`.
 */
export function siteSource(options: SiteSourceOptions = {}): SiteSource {
  const get = options.fetch ?? globalThis.fetch
  const maxPages = options.maxPages ?? 200
  const maxBytes = options.maxBytes ?? 5_000_000
  const delayMs = options.delayMs ?? 500
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const now = options.now ?? (() => new Date())

  const status = (state: LibrarySourceStatus['status'], message: string) => ({
    status: state,
    at: now().toISOString(),
    message,
  })

  return async (library) => {
    let home: URL
    try {
      home = new URL(library.homepage ?? '')
    } catch {
      return { chunks: [], status: status('missing', 'no homepage') }
    }
    if (!/^https?:$/.test(home.protocol) || notDocsHosts.has(home.hostname))
      return { chunks: [], status: status('missing', `${home.hostname} is not a docs site`) }

    let requests = 0
    let bytes = 0
    const exhausted = () => bytes >= maxBytes
    const fetchText = async (url: URL): Promise<Fetched | undefined> => {
      if (exhausted()) return undefined
      if (requests++ > 0 && delayMs > 0) await sleep(delayMs)
      try {
        const response = await get(url, {
          headers: { 'user-agent': userAgent, accept: 'text/markdown, text/plain, text/html, */*' },
        })
        if (!response.ok) return undefined
        const final = response.url ? new URL(response.url) : url
        if (final.host !== home.host) return undefined
        let text = await response.text()
        const left = maxBytes - bytes
        bytes += text.length
        if (text.length > left) text = text.slice(0, left)
        return { url: final, text, contentType: response.headers.get('content-type') ?? '' }
      } catch {
        return undefined
      }
    }

    const robotsText = await fetchText(new URL('/robots.txt', home))
    const robots = parseRobots(
      robotsText && !looksLikeHtml(robotsText.text, robotsText.contentType) ? robotsText.text : '',
    )
    const allowed = (url: URL) =>
      url.host === home.host && robotsAllows(robots.rules, url.pathname + url.search)

    const chunks: Omit<LibraryChunk, 'versions'>[] = []
    const seen = new Set<string>()
    const addDocument = (url: URL, markdown: string) => {
      const pageUrl = new URL(url)
      pageUrl.hash = ''
      const ref = { ecosystem: library.ecosystem, name: library.name }
      for (const chunk of documentChunks(ref, 'site', url.pathname, markdown, {
        url: pageUrl.href,
        max: maxChunk,
      })) {
        if (seen.has(chunk.id)) continue
        seen.add(chunk.id)
        chunks.push(chunk)
      }
    }
    const markdownOf = (page: Fetched) =>
      looksLikeHtml(page.text, page.contentType) ? htmlToMarkdown(page.text) : page.text
    const done = (how: string, pages?: number) =>
      chunks.length
        ? {
            chunks,
            status: status(
              'ok',
              `${how}: ${pages === undefined ? '' : `${pages} pages, `}${chunks.length} chunks${exhausted() ? ', byte limit reached' : ''}`,
            ),
          }
        : undefined

    const base = new URL(home)
    base.search = ''
    base.hash = ''
    if (!base.pathname.endsWith('/') && !/\.[a-z0-9]+$/i.test(base.pathname)) base.pathname += '/'
    const candidates = (file: string) => {
      const urls = [new URL(file, base), new URL(`/${file}`, home)]
      return urls.filter(
        (url, index) =>
          urls.findIndex((other) => other.href === url.href) === index && allowed(url),
      )
    }
    const firstText = async (file: string) => {
      for (const url of candidates(file)) {
        const page = await fetchText(url)
        if (page && page.text.trim() && !looksLikeHtml(page.text, page.contentType)) return page
      }
      return undefined
    }

    const full = await firstText('llms-full.txt')
    if (full) {
      addDocument(full.url, full.text)
      const result = done('llms-full.txt')
      if (result) return result
    }

    const index = await firstText('llms.txt')
    if (index) {
      addDocument(index.url, index.text)
      const links: URL[] = []
      for (const match of index.text.matchAll(
        /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
      )) {
        let url: URL
        try {
          url = new URL(match[1] ?? '', index.url)
        } catch {
          continue
        }
        url.hash = ''
        if (!allowed(url) || links.some((link) => link.href === url.href)) continue
        if (url.href === index.url.href) continue
        links.push(url)
      }
      let pages = 0
      for (const url of links.slice(0, maxPages)) {
        if (exhausted()) break
        const page = await fetchText(url)
        if (!page) continue
        pages++
        addDocument(page.url, markdownOf(page))
      }
      const result = done('llms.txt', pages)
      if (result) return result
    }

    const listed = robots.sitemaps.flatMap((href) => {
      try {
        return [new URL(href, home)]
      } catch {
        return []
      }
    })
    const sitemapQueue = (listed.length ? listed : [new URL('/sitemap.xml', home)]).filter(
      (url) => url.host === home.host,
    )
    const visited = new Set<string>()
    const pageUrls: URL[] = []
    while (sitemapQueue.length && visited.size < maxSitemaps) {
      const url = sitemapQueue.shift()
      if (!url || visited.has(url.href)) continue
      visited.add(url.href)
      const sitemap = await fetchText(url)
      if (!sitemap) continue
      const nested = /<sitemapindex\b/i.test(sitemap.text)
      for (const match of sitemap.text.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)) {
        let loc: URL
        try {
          loc = new URL(decode(match[1] ?? ''), url)
        } catch {
          continue
        }
        if (nested) {
          if (loc.host === home.host) sitemapQueue.push(loc)
        } else if (allowed(loc) && !pageUrls.some((page) => page.href === loc.href)) {
          loc.hash = ''
          pageUrls.push(loc)
        }
      }
    }
    const preferred = pageUrls.filter((url) => preferredPath.test(url.pathname))
    const underHome =
      base.pathname === '/' ? [] : pageUrls.filter((url) => url.pathname.startsWith(base.pathname))
    const chosen = preferred.length ? preferred : underHome.length ? underHome : pageUrls
    let pages = 0
    for (const url of chosen.slice(0, maxPages)) {
      if (exhausted()) break
      const page = await fetchText(url)
      if (!page) continue
      pages++
      addDocument(page.url, markdownOf(page))
    }
    return (
      done('sitemap', pages) ?? {
        chunks,
        status: status(
          'missing',
          pageUrls.length
            ? 'no readable pages on the docs site'
            : `no llms.txt, llms-full.txt or sitemap on ${home.host}`,
        ),
      }
    )
  }
}
