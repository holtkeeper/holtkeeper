import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ignoredInReviewMd,
  pathInstructionsInReviewMd,
  readGuidelines,
  trimText,
} from './guidelines.ts'

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

test('reads guideline files in order within the budget', async () => {
  dir = await mkdtemp(join(tmpdir(), 'review-guidelines-'))
  await writeFile(join(dir, 'REVIEW.md'), '# Review\n\nCheck money math.')
  await writeFile(join(dir, 'AGENTS.md'), 'rule line\n'.repeat(2000))
  const found = await readGuidelines(dir, { perFile: 1000, total: 1500 })
  expect(found.map((g) => [g.file, g.truncated])).toEqual([
    ['REVIEW.md', false],
    ['AGENTS.md', true],
  ])
  expect(found[1]?.text.endsWith('[...]')).toBe(true)
})

test('trimText cuts at a line break', () => {
  expect(trimText('aaaa\nbbbb\ncccc', 11)).toEqual({ text: 'aaaa\nbbbb\n[...]', truncated: true })
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
