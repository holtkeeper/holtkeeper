import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { asset } from '../test/assets.ts'
import {
  VORBIS_Q4_BITRATE,
  candidateFor,
  candidates,
  estimateRatios,
  estimateSuggestions,
  measureSuggestions,
} from './suggest.ts'

const opaque = asset('a.png', { bytes: 100_000, image: { width: 10, height: 10, alpha: false } })
const alpha = asset('b.png', { bytes: 100_000, image: { width: 10, height: 10, alpha: true } })
const photo = asset('c.jpg', { bytes: 100_000 })
const sound = asset('d.wav', { kind: 'audio', bytes: 1_000_000, audio: { durationMs: 2000 } })
const font = asset('e.ttf', { kind: 'font', bytes: 100_000 })

test('one candidate per asset by rule', () => {
  expect(candidateFor(opaque)).toMatchObject({ rule: 'opaque-png', suggested: 'webp' })
  expect(candidateFor(alpha)).toMatchObject({
    rule: 'alpha-png',
    estimate: 100_000 * estimateRatios['alpha-png'],
  })
  expect(candidateFor(photo)).toMatchObject({
    rule: 'jpeg',
    suggested: 'webp',
    how: 'WebP lossy q80 (cwebp -q 80)',
  })
  expect(candidateFor(photo, { avif: true })).toMatchObject({ rule: 'jpeg', suggested: 'avif' })
  expect(candidateFor(opaque)?.how).not.toContain('AVIF')
  expect(candidateFor(sound)).toMatchObject({
    rule: 'uncompressed-audio',
    estimate: (2 * VORBIS_Q4_BITRATE) / 8 + 4096,
  })
  expect(candidateFor(font)).toMatchObject({ rule: 'desktop-font', suggested: 'woff2' })
  expect(candidateFor(asset('x.webp'))).toBeUndefined()
  expect(
    candidateFor(asset('x.png', { image: { width: 1, height: 1, animated: true } })),
  ).toBeUndefined()
})

test('small files, build copies and tiny savings are skipped', () => {
  const list = candidates(
    [
      opaque,
      asset('small.png', { bytes: 100, image: { width: 1, height: 1 } }),
      { ...opaque, path: 'dist/a.png', origin: 'build' },
    ],
    1024,
  )
  expect(list.map((candidate) => candidate.asset.path)).toEqual(['a.png'])
  expect(estimateSuggestions(list, 50_000)).toEqual([])
  expect(estimateSuggestions(list, 1)[0]).toMatchObject({ saving: 40_000, method: 'estimate' })
})

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'assets-suggest-'))
  await Promise.all(
    ['a.png', 'c.jpg', 'e.ttf', 'd.wav'].map((name) => writeFile(join(dir, name), 'x')),
  )
})
afterAll(() => rm(dir, { recursive: true, force: true }))

test('tools measure real sizes on temp copies and fall back to estimates', async () => {
  const { runner, calls } = createFakeRunner(async (command) => {
    if (command[0] === 'cwebp') {
      await writeFile(command.at(-1) ?? '', new Uint8Array(10_000))
      return undefined
    }
    if (command[0] === 'woff2_compress') {
      await writeFile((command[1] ?? '').replace(/\.ttf$/, '.woff2'), new Uint8Array(30_000))
      return undefined
    }
    if (command[0] === 'avifenc') throw new Error('command not found: avifenc')
    return { exitCode: 1, stderr: 'Unknown encoder libvorbis' }
  })
  const list = candidates([opaque, photo, font, sound], 1, { avif: true })
  const { suggestions, tools } = await measureSuggestions(list, {
    dir,
    runner,
    minSaving: 1,
    concurrency: 2,
  })
  expect(tools).toEqual(['cwebp', 'woff2_compress'])
  expect(Object.fromEntries(suggestions.map((s) => [s.path, [s.expectedBytes, s.method]]))).toEqual(
    {
      'a.png': [10_000, 'measured'],
      'c.jpg': [70_000, 'estimate'],
      'e.ttf': [30_000, 'measured'],
      'd.wav': [36_096, 'estimate'],
    },
  )
  for (const call of calls) expect(call.options.cwd.startsWith(dir)).toBe(false)
})
