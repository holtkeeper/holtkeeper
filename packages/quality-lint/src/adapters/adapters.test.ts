import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LinterAdapter } from '../types.ts'
import {
  astGrepAdapter,
  biomeAdapter,
  eslintAdapter,
  golangciLintAdapter,
  oxlintAdapter,
  ruffAdapter,
  semgrepAdapter,
} from './index.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function project(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'quality-lint-adapter-'))
  dirs.push(dir)
  await Promise.all(
    Object.entries(files).map(async ([file, text]) => {
      await mkdir(join(dir, file, '..'), { recursive: true })
      await Bun.write(join(dir, file), text)
    }),
  )
  return dir
}

const cases: { adapter: LinterAdapter; files: Record<string, string>; command: string[] }[] = [
  {
    adapter: oxlintAdapter(),
    files: { '.oxlintrc.json': '{}' },
    command: ['oxlint', '-f', 'sarif'],
  },
  {
    adapter: oxlintAdapter(),
    files: { 'package.json': '{"devDependencies":{"oxlint":"1"}}' },
    command: ['oxlint', '-f', 'sarif'],
  },
  {
    adapter: eslintAdapter(),
    files: { 'eslint.config.js': 'export default []' },
    command: ['eslint', '--format', 'json-with-metadata', '.'],
  },
  {
    adapter: eslintAdapter(),
    files: { 'package.json': '{"eslintConfig":{}}' },
    command: ['eslint', '--format', 'json-with-metadata', '.'],
  },
  {
    adapter: biomeAdapter(),
    files: { 'biome.json': '{}' },
    command: ['biome', 'lint', '--reporter=sarif', '--max-diagnostics=none', '--colors=off'],
  },
  {
    adapter: golangciLintAdapter(),
    files: { '.golangci.yml': 'version: "2"' },
    command: ['golangci-lint', 'run', '--output.sarif.path=stdout', '--show-stats=false'],
  },
  {
    adapter: ruffAdapter(),
    files: { 'pyproject.toml': '[tool.ruff]\nline-length = 100\n' },
    command: ['ruff', 'check', '--output-format', 'sarif', '--no-cache'],
  },
  {
    adapter: semgrepAdapter(),
    files: { '.semgrep/rules.yml': 'rules: []' },
    command: ['semgrep', 'scan', '--sarif', '--quiet', '--config', '.semgrep', '--metrics=off'],
  },
  {
    adapter: astGrepAdapter(),
    files: { 'sgconfig.yml': 'ruleDirs: [rules]' },
    command: ['ast-grep', 'scan', '--format', 'sarif'],
  },
]

const fix = (line: number) => ({
  artifactChanges: [
    {
      artifactLocation: { uri: 'a.js' },
      replacements: [{ deletedRegion: { startLine: line, startColumn: 1, endColumn: 4 } }],
    },
  ],
})

describe('adapters', () => {
  test.each(cases)(
    '$adapter.name detects its config and builds its command',
    async ({ adapter, files, command }) => {
      const dir = await project(files)
      expect(await adapter.detect(dir)).toBe(true)
      expect(adapter.command(dir)).toEqual(command)
    },
  )

  test.each(cases.map(({ adapter }) => adapter))(
    '$name stays off in an unrelated project',
    async (adapter) => {
      const dir = await project({
        'package.json': '{"dependencies":{"left-pad":"1"}}',
        'pyproject.toml': '[project]',
      })
      expect(await adapter.detect(dir)).toBe(false)
    },
  )

  test('prefers the project binary', async () => {
    const dir = await project({ 'node_modules/.bin/oxlint': '', '.venv/bin/ruff': '' })
    expect(oxlintAdapter().command(dir)[0]).toBe(join(dir, 'node_modules/.bin/oxlint'))
    expect(ruffAdapter().command(dir)[0]).toBe(join(dir, '.venv/bin/ruff'))
  })

  test('eslint uses the SARIF formatter when the project has it', async () => {
    const dir = await project({
      'node_modules/@microsoft/eslint-formatter-sarif/package.json': '{}',
    })
    expect(eslintAdapter().command(dir)).toContain('@microsoft/eslint-formatter-sarif')
    expect(eslintAdapter({ format: 'json' }).command(dir)).toContain('json-with-metadata')
  })

  test('eslint parses either output', async () => {
    const dir = await project({ 'a.js': 'var a\n' })
    const sarif = {
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'ESLint' } },
          results: [{ ruleId: 'no-var', message: { text: 'x' } }],
        },
      ],
    }
    const json = [
      {
        filePath: join(dir, 'a.js'),
        messages: [{ ruleId: 'no-var', severity: 1, message: 'x', line: 1, column: 1 }],
      },
    ]
    const fromSarif = await eslintAdapter().parse(JSON.stringify(sarif), dir)
    const fromJson = await eslintAdapter().parse(JSON.stringify(json), dir)
    expect(fromSarif.issues[0]).toMatchObject({ tool: 'eslint', rule: 'no-var' })
    expect(fromJson.issues[0]).toMatchObject({ tool: 'eslint', rule: 'no-var', file: 'a.js' })
  })

  test('semgrep runs registry rules only when enabled', async () => {
    const dir = await project({})
    expect(await semgrepAdapter({ auto: true }).detect(dir)).toBe(true)
    expect(semgrepAdapter({ auto: true }).command(dir)).toEqual([
      'semgrep',
      'scan',
      '--sarif',
      '--quiet',
      '--config',
      'auto',
    ])
  })

  test('oxlint marks plain fixes safe and suggestions for review', async () => {
    const dir = await project({ 'a.js': 'debugger\nvar a\n' })
    const log = {
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'oxlint',
              rules: [
                { id: 'a', properties: { fix: 'fixable_fix' } },
                { id: 'b', properties: { fix: 'fixable_suggestion' } },
              ],
            },
          },
          results: [
            { ruleId: 'a', ruleIndex: 0, message: { text: 'a' }, fixes: [fix(1)] },
            { ruleId: 'b', ruleIndex: 1, message: { text: 'b' }, fixes: [fix(2)] },
          ],
        },
      ],
    }
    const { changes } = await oxlintAdapter().parse(JSON.stringify(log), dir)
    expect(changes.map((change) => change.confidence)).toEqual(['safe', 'review'])
  })
})
