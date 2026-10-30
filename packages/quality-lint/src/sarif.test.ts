import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { diskFiles, planChanges } from '@holtkeeper/changes'
import type { Log } from 'sarif'

import { parseSarif } from './sarif.ts'

const oxlintLog = await Bun.file(join(import.meta.dir, '../test/oxlint.sarif.json')).text()

const sources = {
  'src/a.js':
    'const unused = 1\ndebugger\nif (x == null) { console.log("a") }\nlet y = 5\nexport { y }\n',
  'src/b.ts': 'var a = 1;\nif (!a instanceof Object) {}\nexport default a\n',
}

async function project(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'quality-lint-'))
  await Promise.all(
    Object.entries(files).map(async ([file, text]) => {
      await mkdir(join(dir, file, '..'), { recursive: true })
      await Bun.write(join(dir, file), text)
    }),
  )
  return dir
}

const withProject = async (files: Record<string, string>, body: (dir: string) => Promise<void>) => {
  const dir = await project(files)
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const log = (run: Partial<Log['runs'][number]>): Log => ({
  version: '2.1.0',
  runs: [{ tool: { driver: { name: 'demo', rules: [] } }, ...run }],
})

const location = (uri: string, uriBaseId?: string) => ({
  ruleId: 'x',
  message: { text: 'x' },
  locations: [
    {
      physicalLocation: {
        artifactLocation: { uri, ...(uriBaseId ? { uriBaseId } : {}) },
        region: { startLine: 1 },
      },
    },
  ],
})

describe('parseSarif', () => {
  test('reads oxlint output', () =>
    withProject(sources, async (dir) => {
      const { issues, changes } = await parseSarif(oxlintLog, { dir })
      expect(changes).toEqual([])
      expect(
        issues.map((issue) => [issue.tool, issue.rule, issue.file, issue.severity, issue.category]),
      ).toEqual([
        ['oxlint', 'eslint(no-unused-vars)', 'src/a.js', 'warning', 'lint'],
        ['oxlint', 'eslint(no-debugger)', 'src/a.js', 'warning', 'lint'],
        ['oxlint', 'eslint(no-unsafe-negation)', 'src/b.ts', 'warning', 'lint'],
      ])
      expect(issues[0]).toMatchObject({
        range: { start: { line: 1, column: 7 }, end: { line: 1, column: 13 } },
        url: 'https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-unused-vars.html',
      })
    }))

  test('ids follow the offending text, not its position', () =>
    withProject(sources, async (dir) => {
      const before = await parseSarif(oxlintLog, { dir })
      await Bun.write(join(dir, 'src/a.js'), `// header\n${sources['src/a.js']}`)
      const moved = JSON.parse(oxlintLog) as Log
      for (const result of moved.runs[0]?.results ?? []) {
        const region = result.locations?.[0]?.physicalLocation?.region
        if (
          region &&
          result.locations?.[0]?.physicalLocation?.artifactLocation?.uri === 'src/a.js'
        ) {
          region.startLine = (region.startLine ?? 1) + 1
          region.endLine = (region.endLine ?? 1) + 1
        }
      }
      const after = await parseSarif(moved, { dir })
      expect(after.issues.map((issue) => issue.id)).toEqual(before.issues.map((issue) => issue.id))
      expect(new Set(before.issues.map((issue) => issue.id)).size).toBe(3)
    }))

  test('maps levels, help, tags and message templates', () =>
    withProject({ 'a.py': 'import os\n' }, async (dir) => {
      const { issues } = await parseSarif(
        log({
          tool: {
            driver: {
              name: 'scanner',
              rules: [
                {
                  id: 'R1',
                  helpUri: 'https://example.test/R1',
                  help: { text: 'Avoid shell injection.' },
                  properties: { tags: ['security', 'external/cwe/cwe-78'] },
                  messageStrings: { default: { text: 'Found {0} here' } },
                },
                { id: 'C901', defaultConfiguration: { level: 'note' } },
              ],
            },
          },
          results: [
            {
              ruleId: 'R1',
              level: 'error',
              message: { id: 'default', arguments: ['os'] },
              locations: [
                {
                  physicalLocation: { artifactLocation: { uri: 'a.py' }, region: { startLine: 1 } },
                },
              ],
            },
            { ruleId: 'C901', message: { text: 'too complex' } },
            {
              ruleId: 'C901',
              message: { text: 'suppressed' },
              suppressions: [{ kind: 'inSource' }],
            },
          ],
        }),
        { dir },
      )
      expect(issues).toHaveLength(2)
      expect(issues[0]).toMatchObject({
        tool: 'scanner',
        severity: 'error',
        category: 'security',
        message: 'Found os here',
        help: 'Avoid shell injection.',
        url: 'https://example.test/R1',
        file: 'a.py',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 10 } },
      })
      expect(issues[1]).toMatchObject({ severity: 'info', category: 'complexity' })
      expect(issues[1]?.file).toBeUndefined()
    }))

  test('resolves absolute URIs and uriBaseIds against the project', () =>
    withProject({ 'pkg/main.go': 'package main\n' }, async (dir) => {
      const { issues } = await parseSarif(
        log({
          originalUriBaseIds: { SRCROOT: { uri: `${Bun.pathToFileURL(dir).href}/` } },
          results: [
            location(Bun.pathToFileURL(join(dir, 'pkg/main.go')).href),
            location('pkg/main.go', 'SRCROOT'),
          ],
        }),
        { dir },
      )
      expect(issues.map((issue) => issue.file)).toEqual(['pkg/main.go', 'pkg/main.go'])
    }))

  test('turns fixes into changes that apply', () =>
    withProject({ 'src/x.ts': 'let a = "😀" == b\nvar c = 1\n' }, async (dir) => {
      const { issues, changes } = await parseSarif(
        log({
          tool: { driver: { name: 'demo', rules: [{ id: 'eqeqeq' }, { id: 'no-var' }] } },
          columnKind: 'unicodeCodePoints',
          results: [
            {
              ruleId: 'eqeqeq',
              message: { text: 'Use ===' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'src/x.ts' },
                    region: { startLine: 1, startColumn: 13, endLine: 1, endColumn: 15 },
                  },
                },
              ],
              fixes: [
                {
                  description: { text: 'Replace == with ===' },
                  properties: { safe: true },
                  artifactChanges: [
                    {
                      artifactLocation: { uri: 'src/x.ts' },
                      replacements: [
                        {
                          deletedRegion: {
                            startLine: 1,
                            startColumn: 13,
                            endLine: 1,
                            endColumn: 15,
                          },
                          insertedContent: { text: '===' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              ruleId: 'no-var',
              message: { text: 'Use let' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'src/x.ts' },
                    region: { startLine: 2 },
                  },
                },
              ],
              fixes: [
                {
                  artifactChanges: [
                    {
                      artifactLocation: { uri: 'src/x.ts' },
                      // Code point 17 starts line 2: 16 on line 1, plus the newline.
                      replacements: [
                        {
                          deletedRegion: { charOffset: 17, charLength: 3 },
                          insertedContent: { text: 'let' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
        { dir },
      )
      expect(changes).toHaveLength(2)
      expect(changes[0]).toMatchObject({
        title: 'Replace == with ===',
        confidence: 'safe',
        source: 'demo',
      })
      expect(changes[0]?.edits[0]).toMatchObject({
        oldText: '==',
        range: { start: { line: 1, column: 14 } },
      })
      expect(changes[1]).toMatchObject({ confidence: 'review', edits: [{ oldText: 'var' }] })
      expect(issues.map((issue) => issue.changeId)).toEqual(changes.map((change) => change.id))

      const plan = await planChanges(changes, diskFiles(dir))
      expect(plan.conflicts).toEqual([])
      expect(plan.files).toMatchObject([
        { file: 'src/x.ts', content: 'let a = "😀" === b\nlet c = 1\n' },
      ])
    }))

  test('drops fixes whose file is missing but keeps the issue', () =>
    withProject({}, async (dir) => {
      const { issues, changes } = await parseSarif(
        log({
          results: [
            {
              ruleId: 'x',
              message: { text: 'x' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'gone.ts' },
                    region: { startLine: 3, startColumn: 2 },
                  },
                },
              ],
              fixes: [
                {
                  artifactChanges: [
                    {
                      artifactLocation: { uri: 'gone.ts' },
                      replacements: [{ deletedRegion: { startLine: 3 } }],
                    },
                  ],
                },
              ],
            },
          ],
        }),
        { dir },
      )
      expect(changes).toEqual([])
      expect(issues[0]).toMatchObject({ file: 'gone.ts', range: { start: { line: 3, column: 2 } } })
      expect(issues[0]?.changeId).toBeUndefined()
    }))

  test('rejects input that is not SARIF', () =>
    expect(parseSarif('{"results": []}', { dir: '.' })).rejects.toThrow())
})
