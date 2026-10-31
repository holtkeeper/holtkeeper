import { describe, expect, test } from 'bun:test'

import type { LibraryRecord } from '@holtkeeper/store'

import { htmlToMarkdown, parseRobots, robotsAllows, siteSource, splitSections } from './site.ts'

type Route = string | { body: string; type?: string; status?: number }

const fakeFetch = (routes: Record<string, Route>) => {
  const calls: string[] = []
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    const route = routes[url]
    if (route === undefined) return new Response('not found', { status: 404 })
    const { body, type, status } = typeof route === 'string' ? { body: route } : route
    return new Response(body, {
      status: status ?? 200,
      headers: { 'content-type': type ?? 'text/plain' },
    })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const library = (homepage?: string): LibraryRecord => ({
  ecosystem: 'npm',
  name: 'lib',
  ...(homepage ? { homepage } : {}),
  sources: {},
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const now = () => new Date('2026-10-31T00:00:00.000Z')
const html = (body: string, title = 'Page') =>
  `<!doctype html><html><head><title>${title}</title><style>x{}</style></head><body>${body}</body></html>`

describe('siteSource', () => {
  test('skips homepages that are not docs sites', async () => {
    const { fetch, calls } = fakeFetch({})
    const source = siteSource({ fetch, delayMs: 0, now })
    expect((await source(library('https://github.com/acme/lib'))).status).toEqual({
      status: 'missing',
      at: '2026-10-31T00:00:00.000Z',
      message: 'github.com is not a docs site',
    })
    expect((await source(library())).status.status).toBe('missing')
    expect(calls).toEqual([])
  })

  test('prefers llms-full.txt', async () => {
    const { fetch, calls } = fakeFetch({
      'https://lib.dev/llms-full.txt': '# Lib\n\nIntro.\n\n## Install\n\nRun `npm i lib`.\n',
    })
    const { chunks, status } = await siteSource({ fetch, delayMs: 0, now })(
      library('https://lib.dev'),
    )
    expect(calls).toEqual(['https://lib.dev/robots.txt', 'https://lib.dev/llms-full.txt'])
    expect(status).toMatchObject({ status: 'ok', message: 'llms-full.txt: 2 chunks' })
    expect(chunks[1]).toMatchObject({
      ecosystem: 'npm',
      name: 'lib',
      source: 'site',
      path: '/llms-full.txt',
      headings: ['Lib', 'Install'],
      anchor: 'install',
      text: '## Install\n\nRun `npm i lib`.',
      url: 'https://lib.dev/llms-full.txt#install',
    })
    expect(chunks[1]?.id).toMatch(/^[0-9a-f]{64}$/)
  })

  test('follows same-host llms.txt links, honours robots.txt and waits between requests', async () => {
    const waits: number[] = []
    const { fetch, calls } = fakeFetch({
      'https://lib.dev/robots.txt':
        'User-agent: *\nDisallow: /private\n\nUser-agent: other\nDisallow: /\n',
      'https://lib.dev/docs/llms.txt': [
        '# Lib',
        '',
        '> Docs index.',
        '',
        '- [Guide](/docs/guide.md): how to',
        '- [API](https://lib.dev/docs/api.html)',
        '- [Secret](/private/x.md)',
        '- [Elsewhere](https://other.dev/x.md)',
      ].join('\n'),
      'https://lib.dev/docs/guide.md': {
        body: '# Guide\n\nUse it.\n',
        type: 'text/markdown',
      },
      'https://lib.dev/docs/api.html': {
        body: html(
          '<nav>menu</nav><main><h1>API <a href="#api">#</a></h1><p>Call <code>run()</code>.</p><pre class="language-js"><code>run(&lt;x&gt;)</code></pre></main><footer>f</footer>',
        ),
        type: 'text/html; charset=utf-8',
      },
    })
    const { chunks, status } = await siteSource({
      fetch,
      delayMs: 10,
      sleep: async (ms) => {
        waits.push(ms)
      },
      now,
    })(library('https://lib.dev/docs'))
    expect(calls).toEqual([
      'https://lib.dev/robots.txt',
      'https://lib.dev/docs/llms-full.txt',
      'https://lib.dev/llms-full.txt',
      'https://lib.dev/docs/llms.txt',
      'https://lib.dev/docs/guide.md',
      'https://lib.dev/docs/api.html',
    ])
    expect(waits).toEqual([10, 10, 10, 10, 10])
    expect(status.message).toBe('llms.txt: 2 pages, 3 chunks')
    expect(chunks.map((chunk) => [chunk.path, chunk.headings])).toEqual([
      ['/docs/llms.txt', ['Lib']],
      ['/docs/guide.md', ['Guide']],
      ['/docs/api.html', ['API']],
    ])
    expect(chunks[2]?.text).toBe('# API\n\nCall `run()`.\n\n```js\nrun(<x>)\n```')
  })

  test('falls back to sitemap pages under docs paths', async () => {
    const { fetch, calls } = fakeFetch({
      'https://lib.dev/robots.txt':
        'User-agent: holtkeeper\nDisallow: /docs/old\n\nSitemap: https://lib.dev/sitemap-index.xml\n',
      'https://lib.dev/sitemap-index.xml':
        '<sitemapindex><sitemap><loc>https://lib.dev/sitemap-0.xml</loc></sitemap></sitemapindex>',
      'https://lib.dev/sitemap-0.xml': `<urlset>
        <url><loc>https://lib.dev/</loc></url>
        <url><loc>https://lib.dev/blog/post</loc></url>
        <url><loc>https://lib.dev/docs/start</loc></url>
        <url><loc>https://lib.dev/docs/old</loc></url>
        <url><loc>https://lib.dev/reference/api</loc></url>
      </urlset>`,
      'https://lib.dev/docs/start': {
        body: html(
          '<header>top</header><article><h2>Start</h2><ul><li>One</li><li>Two</li></ul></article>',
          'Start | Lib',
        ),
        type: 'text/html',
      },
      'https://lib.dev/reference/api': { body: html('<p>Nothing</p>'), type: 'text/html' },
    })
    const { chunks, status } = await siteSource({ fetch, delayMs: 0, now, maxPages: 5 })(
      library('https://lib.dev/'),
    )
    expect(calls.slice(-4)).toEqual([
      'https://lib.dev/sitemap-index.xml',
      'https://lib.dev/sitemap-0.xml',
      'https://lib.dev/docs/start',
      'https://lib.dev/reference/api',
    ])
    expect(calls).not.toContain('https://lib.dev/sitemap.xml')
    expect(status.message).toBe('sitemap: 2 pages, 2 chunks')
    expect(chunks[0]).toMatchObject({
      path: '/docs/start',
      headings: ['Start | Lib', 'Start'],
      text: '## Start\n\n- One\n- Two',
      url: 'https://lib.dev/docs/start#start',
    })
    expect(chunks[1]).toMatchObject({ headings: ['Page'], text: '# Page\n\nNothing' })
  })

  test('missing when the site has nothing', async () => {
    const { fetch } = fakeFetch({})
    const { chunks, status } = await siteSource({ fetch, delayMs: 0, now })(
      library('https://lib.dev'),
    )
    expect(chunks).toEqual([])
    expect(status).toMatchObject({
      status: 'missing',
      message: 'no llms.txt, llms-full.txt or sitemap on lib.dev',
    })
  })

  test('stops at maxBytes', async () => {
    const { fetch, calls } = fakeFetch({
      'https://lib.dev/llms.txt': `# Lib\n\n${'x'.repeat(50)}\n\n- [A](/a.md)\n- [B](/b.md)\n`,
      'https://lib.dev/a.md': `# A\n\n${'a'.repeat(100)}`,
      'https://lib.dev/b.md': '# B\n\nb',
    })
    const { status } = await siteSource({ fetch, delayMs: 0, now, maxBytes: 120 })(
      library('https://lib.dev'),
    )
    expect(calls).not.toContain('https://lib.dev/b.md')
    expect(status.message).toBe('llms.txt: 1 pages, 2 chunks, byte limit reached')
  })
})

describe('robots', () => {
  test('own group wins over *, longest rule wins', () => {
    const { rules, sitemaps } = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: Holtkeeper\nUser-agent: other\nDisallow: /a\nAllow: /a/b\nDisallow: /*.pdf$\nSitemap: https://x/s.xml',
    )
    expect(sitemaps).toEqual(['https://x/s.xml'])
    expect(robotsAllows(rules, '/')).toBe(true)
    expect(robotsAllows(rules, '/a/c')).toBe(false)
    expect(robotsAllows(rules, '/a/b/c')).toBe(true)
    expect(robotsAllows(rules, '/x.pdf')).toBe(false)
    expect(robotsAllows(rules, '/x.pdf?y')).toBe(true)
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /\n').rules, '/docs')).toBe(false)
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow:\n').rules, '/docs')).toBe(true)
  })
})

describe('htmlToMarkdown and splitSections', () => {
  test('drops page chrome from the body when there is no main', () => {
    expect(
      htmlToMarkdown(
        html(
          '<header>logo</header><nav><ul><li>x</li></ul></nav><h1>T</h1><p>a&amp;b &#x41;</p><table><tr><td>1</td><td>2</td></tr></table><script>x()</script>',
        ),
      ),
    ).toBe('# T\n\na&b A\n\n| 1 | 2 |')
  })

  test('splits long sections and keeps fences whole', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'w'.repeat(80)}`).join(
      '\n\n',
    )
    const sections = splitSections(`# A\n\n${long}\n\n## B\n\n\`\`\`\n# not a heading\n\`\`\`\n`)
    expect(sections.length).toBeGreaterThan(2)
    expect(sections.every((section) => section.text.length <= 1500)).toBe(true)
    expect(sections.at(-1)).toEqual({
      headings: ['A', 'B'],
      text: '## B\n\n```\n# not a heading\n```',
    })
    expect(splitSections('### Deep\n\ntext')[0]?.headings).toEqual(['Deep'])
  })
})
