import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { ignoredInReviewMd, pathInstructionsInReviewMd, readCheckoutRules } from './guidelines.ts'

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

test('reads the rules files git tracks, nested ones included', async () => {
  dir = await mkdtemp(join(tmpdir(), 'review-rules-'))
  await mkdir(join(dir, 'pkg/widgets'), { recursive: true })
  await writeFile(join(dir, 'REVIEW.md'), '# Review\n\nCheck money math.')
  await writeFile(join(dir, 'pkg/widgets/AGENTS.md'), 'Keep widget sizes in WidgetSize.')
  await writeFile(join(dir, 'untracked.md'), 'x')
  const { runner } = createFakeRunner(() => ({
    stdout: 'REVIEW.md\npkg/widgets/AGENTS.md\nsrc/a.ts\n',
  }))
  const found = await readCheckoutRules(runner, dir)
  expect(found.map((file) => [file.path, file.kind, file.globs])).toEqual([
    ['REVIEW.md', 'always', []],
    ['pkg/widgets/AGENTS.md', 'files', ['pkg/widgets/**']],
  ])
})

test('falls back to root rules files when git cannot list', async () => {
  dir = await mkdtemp(join(tmpdir(), 'review-rules-'))
  await writeFile(join(dir, 'AGENTS.md'), 'Use tabs.')
  const { runner } = createFakeRunner(() => ({ exitCode: 128 }))
  const found = await readCheckoutRules(runner, dir)
  expect(found.map((file) => file.path)).toEqual(['AGENTS.md'])
})

test('ignoredInReviewMd reads globs under an Ignore heading', () => {
  const text = [
    '# Rules',
    '- be kind',
    '## Ignore',
    '- `src/generated/**`',
    '* legacy/*.js',
    '## Focus',
    '- security',
  ].join('\n')
  expect(ignoredInReviewMd(text)).toEqual(['src/generated/**', 'legacy/*.js'])
})

test('pathInstructionsInReviewMd reads glob rules under a Paths heading', () => {
  const text = [
    '## Ignore',
    '- `src/generated/**`',
    '## Paths',
    '- `migrations/**`: every migration must be reversible.',
    '- src/api/**: keep the public contract;',
    '  bump the version on breaking changes.',
    '- `docs/**`:',
    '## Focus',
    '- `x`: not a path rule',
  ].join('\n')
  expect(pathInstructionsInReviewMd(text)).toEqual([
    { glob: 'migrations/**', text: 'every migration must be reversible.' },
    { glob: 'src/api/**', text: 'keep the public contract; bump the version on breaking changes.' },
  ])
})
