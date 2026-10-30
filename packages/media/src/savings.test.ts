import { expect, test } from 'bun:test'

import { changeItem, codeChangeSchema, positionAt, replaceFile } from './changes.ts'
import { savingsMarkdown, savingsSummary } from './savings.ts'

const original = { bytes: 400_000, width: 1920, format: 'png' }
const variants = [
  { format: 'avif' as const, width: 640, bytes: 20_000 },
  { format: 'avif' as const, width: 1280, bytes: 50_000 },
  { format: 'avif' as const, width: 1920, bytes: 90_000 },
  { format: 'webp' as const, width: 640, bytes: 30_000 },
  { format: 'webp' as const, width: 1280, bytes: 80_000 },
  { format: 'webp' as const, width: 1920, bytes: 140_000 },
  { format: 'png' as const, width: 1920, bytes: 300_000 },
]

test('per-format savings at full size and the best format', () => {
  const summary = savingsSummary(original, variants)
  expect(summary.formats).toEqual([
    {
      format: 'avif',
      bytes: 90_000,
      width: 1920,
      smallest: 20_000,
      saving: 310_000,
      savingPercent: 77.5,
    },
    {
      format: 'webp',
      bytes: 140_000,
      width: 1920,
      smallest: 30_000,
      saving: 260_000,
      savingPercent: 65,
    },
    {
      format: 'png',
      bytes: 300_000,
      width: 1920,
      smallest: 300_000,
      saving: 100_000,
      savingPercent: 25,
    },
  ])
  expect(summary.best?.format).toBe('avif')
})

test('viewports pick the smallest sufficient width at DPR 2', () => {
  const summary = savingsSummary(original, variants)
  expect(summary.viewports.map((row) => [row.viewport, row.needed, row.best])).toEqual([
    [375, 750, { format: 'avif', width: 1280, bytes: 50_000 }],
    [768, 1536, { format: 'avif', width: 1920, bytes: 90_000 }],
    [1440, 2880, { format: 'avif', width: 1920, bytes: 90_000 }],
  ])
  expect(summary.viewports[0]?.savingPercent).toBe(87.5)
  const half = savingsSummary(original, variants, { fraction: 0.5, dpr: 1, viewports: [1200] })
  expect(half.viewports[0]?.picks).toEqual([
    { format: 'avif', width: 640, bytes: 20_000 },
    { format: 'webp', width: 640, bytes: 30_000 },
    { format: 'png', width: 1920, bytes: 300_000 },
  ])
})

test('density variants are picked by DPR', () => {
  const summary = savingsSummary(
    { bytes: 100_000, width: 512, format: 'png' },
    [
      { format: 'webp', width: 256, bytes: 10_000, density: 1 },
      { format: 'webp', width: 512, bytes: 30_000, density: 2 },
    ],
    { dpr: 1, viewports: [375] },
  )
  expect(summary.viewports[0]?.best).toEqual({ format: 'webp', width: 256, bytes: 10_000 })
})

test('markdown tables for merge request comments', () => {
  const text = savingsMarkdown(
    savingsSummary(original, variants, { viewports: [375] }),
    'public/hero.png',
  )
  expect(text).toBe(
    [
      '**public/hero.png**',
      '',
      '| Format | Width | Size | Change |',
      '| --- | ---: | ---: | ---: |',
      '| original png | 1920 | 391 kB | — |',
      '| avif (best) | 1920 | 87.9 kB | −77.5% |',
      '| webp | 1920 | 137 kB | −65% |',
      '| png | 1920 | 293 kB | −25% |',
      '',
      '| Viewport | Needs | avif | webp | png | Original |',
      '| --- | ---: | ---: | ---: | ---: | ---: |',
      '| 375 px @2x | 750 px | 48.8 kB (1280w) | 78.1 kB (1280w) | 293 kB (1920w) | 391 kB |',
    ].join('\n'),
  )
})

test('changes: whole-file replace, positions, schema and binary diffs', () => {
  expect(positionAt('ab\ncd\n', 4)).toEqual({ line: 2, column: 2 })
  expect(positionAt('ab', 0)).toEqual({ line: 1, column: 1 })
  const edit = replaceFile('a.svg', '<svg>\n</svg>\n', '<svg/>')
  expect(edit).toMatchObject({
    range: { start: { line: 1, column: 1 }, end: { line: 3, column: 1 } },
  })
  const change = {
    id: 'x',
    title: 'Optimize',
    confidence: 'review' as const,
    source: 'media',
    edits: [
      edit,
      { kind: 'write-binary' as const, file: 'a.webp', bytes: 10, artifact: 'f'.repeat(64) },
      {
        kind: 'write-binary' as const,
        file: 'a.png',
        bytes: 10,
        artifact: 'e'.repeat(64),
        previousSha256: 'd'.repeat(64),
      },
    ],
  }
  expect(codeChangeSchema.parse(change)).toEqual(change)
  const item = changeItem(change, { tags: ['svg'] })
  expect(item.diff.map((diff) => [diff.file, diff.status, diff.hunks.length > 0])).toEqual([
    ['a.svg', 'modified', true],
    ['a.webp', 'added', false],
    ['a.png', 'modified', false],
  ])
  expect(item.tags).toEqual(['svg'])
})
