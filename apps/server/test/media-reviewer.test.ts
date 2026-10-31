import { expect, test } from 'bun:test'

import { requireSharp } from '@holtkeeper/media'
import type { VariantCache } from '@holtkeeper/media'
import type { MediaReviewInput } from '@holtkeeper/review'

import { createMediaReviewer, panelLink } from '../src/media/reviewer.ts'

const photo = async () => {
  const sharp = await requireSharp()
  return new Uint8Array(
    await sharp({
      create: {
        width: 1200,
        height: 600,
        channels: 3,
        background: '#446688',
        noise: { type: 'gaussian', mean: 110, sigma: 15 },
      },
    })
      .png()
      .toBuffer(),
  )
}

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: Sketch 98 (12345) - https://sketch.com -->
<svg width="24px" height="24px" viewBox="0 0 24 24" version="1.1" xmlns="http://www.w3.org/2000/svg">
  <title>check</title>
  <desc>Created with Sketch.</desc>
  <g id="check" stroke="none" stroke-width="1" fill="none" fill-rule="evenodd">
    <path d="M9.000000,16.170000 L4.830000,12.000000 L3.410000,13.410000 L9.000000,19.000000 L21.000000,7.000000 L19.590000,5.590000 Z" fill="#000000"></path>
  </g>
</svg>
`

const base = {
  repo: { forge: 'work', path: 'web/site' },
  mergeRequest: 7,
  refs: { baseSha: 'a', startSha: 'a', headSha: 'h1' },
  code: [],
  paths: [],
}

test('without avif only WebP is encoded and asked for', async () => {
  const result = await createMediaReviewer().review({
    ...base,
    paths: ['public/bg-720.png', 'public/bg-1080.png'],
    files: [{ path: 'public/bg-1080.png', status: 'added', bytes: await photo() }],
    usages: [{ path: 'src/App.tsx', line: 4, text: '  <img src="/bg-1080.png" alt="" />' }],
  })
  expect(result.comments[0]?.body.split('\n')[0]).toBe(
    'Serve bg-1080.png as WEBP with responsive <picture>',
  )
  expect(result.comments[0]?.suggestion?.replacement).not.toContain('image/avif')
  expect(result.summary).toContain('`public/bg-1080.png`: no WebP version comes with it.')
})

test('raster images get a savings table, a <picture> suggestion and a panel link', async () => {
  const input: MediaReviewInput = {
    ...base,
    files: [{ path: 'public/hero.png', status: 'added', bytes: await photo() }],
    usages: [
      { path: 'src/App.tsx', line: 12, text: '      <img src="/hero.png" alt="Hero" />' },
      { path: 'README.md', line: 3, text: 'See hero.png' },
    ],
  }
  const result = await createMediaReviewer({
    publicUrl: 'https://hk.example.com/',
    avif: true,
  }).review(input)
  expect(result.comments).toHaveLength(1)
  const comment = result.comments[0]
  expect(comment).toMatchObject({ path: 'src/App.tsx', line: 12 })
  expect(comment?.body.split('\n')[0]).toBe('Serve hero.png as AVIF with responsive <picture>')
  const replacement = comment?.suggestion?.replacement ?? ''
  expect(replacement.startsWith('      <picture>')).toBe(true)
  expect(replacement).toContain('<source type="image/avif" srcSet="/hero-320w.avif 320w')
  expect(replacement).toContain('alt="Hero"')
  expect(result.summary).toContain('**public/hero.png · 1200×600**')
  expect(result.summary).toContain('`public/hero.png`: no AVIF/WebP version comes with it.')
  expect(result.summary).toContain('| 375 px @2x | 750 px |')
  expect(result.summary).toContain(
    '(https://hk.example.com/media?repo=work%3Aweb%2Fsite&file=public%2Fhero.png&ref=h1)',
  )
})

test('an added SVG gets a whole-file suggestion; a modified one only a summary line', async () => {
  const reviewer = createMediaReviewer()
  const added = await reviewer.review({
    ...base,
    files: [{ path: 'icons/check.svg', status: 'added', text: svg }],
    usages: [],
  })
  expect(added.comments[0]).toMatchObject({ path: 'icons/check.svg', startLine: 1, line: 9 })
  expect(added.comments[0]?.suggestion?.replacement).toContain('viewBox="0 0 24 24"')
  expect(added.comments[0]?.suggestion?.replacement).toContain('id="check"')
  expect(added.summary).toMatch(/^`icons\/check\.svg`: \d+ → \d+ bytes/)
  expect(added.summary).not.toContain('](')

  const modified = await reviewer.review({
    ...base,
    files: [{ path: 'icons/check.svg', status: 'modified', text: svg }],
    usages: [],
  })
  expect(modified.comments).toEqual([])
  expect(modified.summary).toContain('icons/check.svg')
})

test('unreadable images are mentioned, not reviewed', async () => {
  const result = await createMediaReviewer().review({
    ...base,
    files: [
      { path: 'a.png', status: 'added' },
      { path: 'b.png', status: 'added', bytes: new Uint8Array([1, 2, 3]) },
    ],
    usages: [],
  })
  expect(result.comments).toEqual([])
  expect(result.summary).toContain('`a.png`: not readable')
  expect(result.summary).toContain('`b.png`: cannot decode')
  expect(panelLink('https://x.test', { ...base, files: [], usages: [] }, 'a b.png')).toBe(
    'https://x.test/media?repo=work%3Aweb%2Fsite&file=a+b.png&ref=h1',
  )
})

const heavy =
  'M12.000000 2.000000C6.4771525 2.000000 2.000000 6.4771525 2.000000 12.000000C2.000000 17.5228475 6.4771525 22.000000 12.000000 22.000000C17.5228475 22.000000 22.000000 17.5228475 22.000000 12.000000C22.000000 6.4771525 17.5228475 2.000000 12.000000 2.000000Z'

test('inline SVGs on added lines get a suggestion covering exactly those lines', async () => {
  const text = [
    'export const Ring = () => (',
    '  <svg viewBox="0 0 24 24">',
    `    <path d="${heavy}" />`,
    '  </svg>',
    ')',
    `export const Old = () => <svg><path d="${heavy}" /></svg>`,
  ].join('\n')
  const result = await createMediaReviewer().review({
    ...base,
    files: [],
    usages: [],
    code: [{ path: 'src/Ring.tsx', text, addedLines: [1, 2, 3, 4, 5] }],
  })
  expect(result.comments.map((comment) => [comment.startLine, comment.line])).toEqual([[2, 4]])
  const replacement = result.comments[0]?.suggestion?.replacement ?? ''
  expect(replacement.split('\n')).toHaveLength(3)
  expect(replacement.startsWith('  <svg viewBox="0 0 24 24">')).toBe(true)
  expect(replacement).not.toContain('.000000')
  expect(result.comments[0]?.body.split('\n')[0]).toBe('Shorten the path data of this inline SVG')
  expect(result.summary).toContain('`src/Ring.tsx`: 1 inline SVG')
})

test('a large image with its AVIF and WebP but one size is flagged, and re-reviews hit the cache', async () => {
  const sharp = await requireSharp()
  const wide = new Uint8Array(
    await sharp({ create: { width: 1600, height: 400, channels: 3, background: '#88aa44' } })
      .png()
      .toBuffer(),
  )
  const entries = new Map<
    string,
    { data: Uint8Array; meta: Record<string, string | number | boolean> }
  >()
  let hits = 0
  const cache: VariantCache = {
    get: async (key) => {
      const entry = entries.get(key)
      if (entry) hits++
      return entry
    },
    set: async (key, data, entry) => {
      entries.set(key, { data, meta: entry?.meta ?? {} })
    },
  }
  const input: MediaReviewInput = {
    ...base,
    files: [{ path: 'public/banner.png', status: 'added', bytes: wide }],
    usages: [],
    paths: ['public/banner.png', 'public/banner.avif', 'public/banner.webp'],
  }
  const reviewer = createMediaReviewer({ cache })
  const first = await reviewer.review(input)
  expect(first.summary).toContain('only one resolution (1600 px wide)')
  expect(first.summary).not.toContain('no AVIF')
  expect(entries.size).toBeGreaterThan(0)
  const second = await reviewer.review(input)
  expect(hits).toBe(entries.size)
  expect(second.summary).toBe(first.summary)
})
