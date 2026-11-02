import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { QualityIssue } from '@holtkeeper/quality'

import { refineFindings } from './refine.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function project(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'quality-deadcode-refine-'))
  dirs.push(dir)
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await Bun.write(join(dir, path), text)
  }
  return dir
}

const issue = (rule: string, file: string, message: string, changeId?: string): QualityIssue => ({
  id: `${rule}:${file}:${message}`,
  tool: 'knip',
  rule,
  category: 'lint',
  severity: 'warning',
  message,
  file,
  ...(changeId ? { changeId } : {}),
})

test('groups unlisted packages and names the dependency that provides them', async () => {
  const dir = await project({
    'package.json': '{ "dependencies": { "shape-kit": "1" } }',
    'node_modules/shape-kit/package.json': '{ "dependencies": { "shape-core": "1" } }',
  })
  const { issues } = await refineFindings(
    {
      issues: [
        issue(
          'deadcode/unlisted-dependency',
          'src/a.ts',
          'shape-core is imported but not listed in package.json',
        ),
        issue(
          'deadcode/unlisted-dependency',
          'src/b.ts',
          'shape-core is imported but not listed in package.json',
        ),
        issue(
          'deadcode/unlisted-dependency',
          'src/b.ts',
          'edge-lib is imported but not listed in package.json',
        ),
      ],
      changes: [],
    },
    dir,
  )
  expect(
    issues.map(({ rule, severity, message, file }) => ({ rule, severity, message, file })),
  ).toEqual([
    {
      rule: 'deadcode/transitive-dependency',
      severity: 'info',
      message:
        'shape-core is imported (2 files, first src/a.ts) but only installed through shape-kit',
      file: 'src/a.ts',
    },
    {
      rule: 'deadcode/unlisted-dependency',
      severity: 'warning',
      message: 'edge-lib is imported but not listed in package.json',
      file: 'src/b.ts',
    },
  ])
})

test('drops stories and tool configs from unused files', async () => {
  const dir = await project({ 'package.json': '{}' })
  const result = await refineFindings(
    {
      issues: [
        issue('deadcode/unused-file', 'src/Shape.stories.tsx', 'Unused file', 'c1'),
        issue('deadcode/unused-file', 'shape-tool.config.js', 'Unused file', 'c2'),
        issue('deadcode/unused-file', 'src/orphan.ts', 'Unused file', 'c3'),
      ],
      changes: ['c1', 'c2', 'c3'].map((id) => ({
        id,
        title: id,
        confidence: 'review' as const,
        source: 'knip',
        edits: [{ kind: 'delete' as const, file: id, oldText: '' }],
      })),
    },
    dir,
  )
  expect(result.issues.map((i) => i.file)).toEqual(['src/orphan.ts'])
  expect(result.changes.map((c) => c.id)).toEqual(['c3'])
})
