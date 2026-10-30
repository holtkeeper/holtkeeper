import { afterEach, describe, expect, test } from 'bun:test'

import {
  confluence,
  confluenceFromCredential,
  ConfluenceApiError,
  detectFlavor,
  MarkerError,
  renderMarker,
  VersionConflictError,
  type ConfluenceAuth,
} from '../src/index.ts'
import { startFakeConfluence, type FakeConfluence } from './fake-confluence.ts'

const TOKEN = 'tok-SECRET-123'
const EMAIL = 'bot@example.com'
const BASIC = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`

const flavors = [
  {
    flavor: 'cloud' as const,
    auth: { kind: 'basic', email: EMAIL, token: TOKEN } as ConfluenceAuth,
    header: BASIC,
  },
  {
    flavor: 'datacenter' as const,
    auth: { kind: 'bearer', token: TOKEN } as ConfluenceAuth,
    header: `Bearer ${TOKEN}`,
  },
]

const start = renderMarker('report', 'start')
const end = renderMarker('report', 'end')

type Variant = (typeof flavors)[number]

let running: FakeConfluence | undefined
afterEach(async () => {
  await running?.stop()
  running = undefined
})

function setup(variant: Variant, body = `<p>intro</p>${start}<p>old</p>${end}<p>outro</p>`) {
  const fake = startFakeConfluence(variant.flavor, variant.header)
  running = fake
  fake.pages.set('100', { id: '100', title: 'Status', version: 3, body })
  const site = confluence({ url: fake.url, auth: variant.auth, flavor: variant.flavor })
  return { fake, site }
}

const pageLink = (flavor: Variant['flavor'], fake: FakeConfluence) =>
  flavor === 'cloud'
    ? `${fake.url}/wiki/spaces/ENG/pages/100/Status`
    : `${fake.url}/pages/viewpage.action?pageId=100`

test('detectFlavor', () => {
  expect(detectFlavor('https://acme.atlassian.net/wiki')).toBe('cloud')
  expect(detectFlavor('https://api.atlassian.com/ex/confluence/abc')).toBe('cloud')
  expect(detectFlavor('https://wiki.example.com')).toBe('datacenter')
})

for (const variant of flavors) {
  const { flavor, header } = variant
  describe(flavor, () => {
    test('reads by id and by link', async () => {
      const { fake, site } = setup(variant)
      const byId = await site.source.read('100')
      expect(byId).toEqual({
        ref: '100',
        title: 'Status',
        version: 3,
        url:
          flavor === 'cloud'
            ? `${fake.url}/wiki/spaces/ENG/pages/100/Status`
            : `${fake.url}/display/ENG/Status`,
        format: 'storage',
        body: fake.pages.get('100')!.body,
      })
      const link = pageLink(flavor, fake)
      expect(await site.source.read(link)).toEqual({ ...byId, ref: link })
      expect(fake.requests[0]!.search).toBe(
        flavor === 'cloud' ? '?body-format=storage' : '?expand=body.storage%2Cversion',
      )
      expect(site.source.provider).toBe('confluence')
    })

    test('replaces an existing section and leaves the rest alone', async () => {
      const { fake, site } = setup(variant)
      const result = await site.sink.replaceSection('100', {
        markerId: 'report',
        content: '<p>new</p>',
        format: 'storage',
        expectedVersion: 3,
        message: 'holtkeeper update',
      })
      expect(result.changed).toBe(true)
      expect(result.version).toBe(4)
      expect(fake.pages.get('100')!.body).toBe(`<p>intro</p>${start}<p>new</p>${end}<p>outro</p>`)
      const put = fake.requests.find((request) => request.method === 'PUT')!
      expect((put.body as { version: unknown }).version).toEqual({
        number: 4,
        message: 'holtkeeper update',
      })
    })

    test('appends a section when markers are missing', async () => {
      const { fake, site } = setup(variant, '<p>page</p>')
      await site.sink.replaceSection('100', {
        markerId: 'report',
        content: 'Hi',
        format: 'markdown',
      })
      expect(fake.pages.get('100')!.body).toBe(`<p>page</p>${start}<p>Hi</p>${end}`)
    })

    test('unchanged content writes nothing', async () => {
      const { fake, site } = setup(
        variant,
        `${start}\n<p>Done &amp; <strong>ok</strong></p>\n${end}`,
      )
      const result = await site.sink.replaceSection(pageLink(flavor, fake), {
        markerId: 'report',
        content: 'Done & **ok**',
        format: 'markdown',
      })
      expect(result).toEqual({ version: 3, url: expect.any(String), changed: false })
      expect(fake.requests.some((request) => request.method === 'PUT')).toBe(false)
    })

    test('expectedVersion mismatch is a version conflict without a write', async () => {
      const { fake, site } = setup(variant)
      const attempt = site.sink.replaceSection('100', {
        markerId: 'report',
        content: 'x',
        format: 'markdown',
        expectedVersion: 2,
      })
      expect(attempt).rejects.toBeInstanceOf(VersionConflictError)
      await attempt.catch(() => undefined)
      expect(fake.requests.some((request) => request.method === 'PUT')).toBe(false)
    })

    test('a concurrent edit during the write is a version conflict', async () => {
      const { fake, site } = setup(variant)
      fake.raceNextPut('100')
      const error = await site.sink
        .replaceSection('100', { markerId: 'report', content: 'x', format: 'markdown' })
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(VersionConflictError)
      expect(error).toMatchObject({ expected: 3, actual: 4 })
    })

    test('markdown is converted and escaped', async () => {
      const { fake, site } = setup(variant)
      await site.sink.replaceSection('100', {
        markerId: 'report',
        content:
          '## Deps <x>\n\n| a | b |\n| - | - |\n| `1` | [l](https://e.com?q=1&r=2) |\n\n```sh\necho "]]>"\n```',
        format: 'markdown',
      })
      const body = fake.pages.get('100')!.body
      expect(body).toContain('<h2>Deps &lt;x&gt;</h2>')
      expect(body).toContain('<td><a href="https://e.com?q=1&amp;r=2">l</a></td>')
      expect(body).toContain('<ac:parameter ac:name="language">sh</ac:parameter>')
      expect(body).toContain('<![CDATA[echo "]]]]><![CDATA[>"]]>')
    })

    test('html is sanitized', async () => {
      const { fake, site } = setup(variant)
      await site.sink.replaceSection('100', {
        markerId: 'report',
        content: '<p onclick="x">a<script>alert(1)</script></p>',
        format: 'html',
      })
      expect(fake.pages.get('100')!.body).toContain(`${start}<p>a</p>${end}`)
    })

    test('broken markers are refused without a write', async () => {
      const { fake, site } = setup(variant, `${start}<p>a</p>`)
      expect(
        site.sink.replaceSection('100', { markerId: 'report', content: 'x', format: 'markdown' }),
      ).rejects.toBeInstanceOf(MarkerError)
      await Bun.sleep(0)
      expect(fake.requests.some((request) => request.method === 'PUT')).toBe(false)
    })

    test('errors never contain the secret', async () => {
      const { fake, site } = setup(variant)
      const echoed =
        flavor === 'cloud'
          ? { errors: [{ title: `bad ${header} ${TOKEN}` }] }
          : { message: `bad ${header} ${TOKEN}` }
      fake.failNext(403, echoed)
      const error = (await site.source
        .read('100')
        .catch((caught: unknown) => caught)) as ConfluenceApiError
      expect(error).toBeInstanceOf(ConfluenceApiError)
      expect(error.status).toBe(403)
      expect(error.message).toContain('403')
      expect(error.message).not.toContain(TOKEN)
      expect(error.message).not.toContain(header.split(' ')[1]!)
    })

    test('retries once on 429', async () => {
      const { fake, site } = setup(variant)
      fake.failNext(429, {}, { 'Retry-After': '0' })
      expect((await site.source.read('100')).version).toBe(3)
      expect(fake.requests).toHaveLength(2)
    })

    test('missing page is an API error', async () => {
      const { site } = setup(variant)
      expect(site.source.read('999')).rejects.toMatchObject({ status: 404 })
    })
  })
}

test('confluenceFromCredential talks to the site with the stored auth', async () => {
  const fake = startFakeConfluence('datacenter', `Bearer ${TOKEN}`)
  running = fake
  fake.pages.set('5', { id: '5', title: 'T', version: 1, body: '' })
  const site = confluenceFromCredential(
    { kind: 'confluence', url: fake.url, options: { authKind: 'bearer' } },
    TOKEN,
  )
  expect((await site.source.read('5')).title).toBe('T')
})

test('redirects are refused', async () => {
  const site = confluence({
    url: 'https://acme.atlassian.net',
    auth: { kind: 'bearer', token: TOKEN },
    fetch: async (_input, init) => {
      expect(init.redirect).toBe('error')
      throw new TypeError(`redirect to https://evil.example.com?t=${TOKEN}`)
    },
  })
  const error = (await site.source.read('1').catch((caught: unknown) => caught)) as Error
  expect(error).toBeInstanceOf(ConfluenceApiError)
  expect(error.message).not.toContain(TOKEN)
})
