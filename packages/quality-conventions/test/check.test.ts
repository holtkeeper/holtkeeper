import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { planChanges } from '@holtkeeper/changes'
import type { QualityContext, QualityResult } from '@holtkeeper/quality'

import { type ConventionsOptions, conventionsCheck } from '../src/index.ts'

const notGit: QualityContext['runner'] = {
  run: async () => ({ exitCode: 128, stdout: '', stderr: 'not a git repository' }),
}
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'conventions-'))
  dirs.push(dir)
  await Promise.all(
    Object.entries(files).map(async ([path, text]) => {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await Bun.write(join(dir, path), text)
    }),
  )
  return dir
}

async function analyze(dir: string, options?: ConventionsOptions): Promise<QualityResult> {
  return conventionsCheck(options).run({ dir, runner: notGit })
}

async function applied(dir: string, result: QualityResult) {
  const plan = await planChanges(result.changes ?? [], {
    read: async (file) => Bun.file(join(dir, file)).text(),
  })
  expect(plan.conflicts).toEqual([])
  return Object.fromEntries(plan.files.map((file) => [file.file, file.content]))
}

const constants = (names: string[]) => names.map((name, i) => `const ${name} = ${i}\n`).join('')
const twelve = Array.from({ length: 12 }, (_, i) => `LIMIT_${String.fromCodePoint(65 + i)}`)

describe('typescript', () => {
  test('flags camelCase module constants and renames every reference', async () => {
    const dir = await project({
      'src/limits.ts': `${constants(twelve.slice(0, 6))}export const all = [${twelve.slice(0, 6).join(', ')}]\n`,
      'src/more.ts': `${constants(twelve.slice(6))}export const rest = [${twelve.slice(6).join(', ')}]\n`,
      'src/greet.ts': [
        "const defaultName = 'world'",
        'export function greet(who?: string) {',
        '  const options = { defaultName, other: 1 }',
        '  return `${who ?? defaultName}!` + options.other',
        '}',
        '',
      ].join('\n'),
      'src/retry.ts': [
        'const retryCount = 3',
        'function retry() {',
        '  for (let i = 0; i < retryCount; i++) {}',
        '  return { retryCount: retryCount }',
        '}',
        'export { retry }',
        '',
      ].join('\n'),
    })
    const result = await analyze(dir)

    const stat = result.conventions?.find(
      (c) => c.language === 'typescript' && c.kind === 'module constant',
    )
    expect(stat).toMatchObject({ dominant: 'SCREAMING_SNAKE_CASE', total: 14, outliers: 2 })

    const issues = result.issues?.filter((issue) => issue.rule === 'naming/module-constant') ?? []
    expect(issues.map((issue) => [issue.file, issue.range?.start])).toEqual([
      ['src/greet.ts', { line: 1, column: 7 }],
      ['src/retry.ts', { line: 1, column: 7 }],
    ])
    expect(issues.every((issue) => issue.category === 'convention' && issue.changeId)).toBe(true)
    expect(
      result.changes?.every(
        (change) => change.confidence === 'review' && change.source === 'conventions',
      ),
    ).toBe(true)

    const files = await applied(dir, result)
    expect(files['src/greet.ts']).toBe(
      [
        "const DEFAULT_NAME = 'world'",
        'export function greet(who?: string) {',
        '  const options = { defaultName: DEFAULT_NAME, other: 1 }',
        '  return `${who ?? DEFAULT_NAME}!` + options.other',
        '}',
        '',
      ].join('\n'),
    )
    expect(files['src/retry.ts']).toBe(
      [
        'const RETRY_COUNT = 3',
        'function retry() {',
        '  for (let i = 0; i < RETRY_COUNT; i++) {}',
        '  return { retryCount: RETRY_COUNT }',
        '}',
        'export { retry }',
        '',
      ].join('\n'),
    )
  })

  test('an exported outlier gets an issue but no change', async () => {
    const dir = await project({
      'limits.ts': `${constants(twelve)}export const maxSize = 1\nexport const all = [maxSize, ${twelve.join(', ')}]\n`,
    })
    const result = await analyze(dir)
    const [issue] = result.issues?.filter((i) => i.rule === 'naming/module-constant') ?? []
    expect(issue).toMatchObject({ file: 'limits.ts', help: 'Rename to `MAX_SIZE`' })
    expect(issue?.changeId).toBeUndefined()
    expect(result.changes).toEqual([])
  })

  test('no change when the new name already exists in the file', async () => {
    const dir = await project({
      'limits.ts': `${constants([...twelve, 'MAX_SIZE'])}const maxSize = 2\nexport const all = [maxSize, MAX_SIZE, ${twelve.join(', ')}]\n`,
    })
    const result = await analyze(dir)
    expect(result.issues?.filter((i) => i.rule === 'naming/module-constant')).toHaveLength(1)
    expect(result.changes).toEqual([])
  })

  test('no convention below the thresholds', async () => {
    const dir = await project({
      'a.ts': `${constants(twelve.slice(0, 5))}const maxSize = 1\nexport {}\n`,
    })
    expect((await analyze(dir)).issues).toEqual([])
    expect((await analyze(dir, { minNames: 5, minShare: 0.8 })).issues).toHaveLength(1)
  })

  test('components, locals and skipped directories', async () => {
    const components = Array.from(
      { length: 10 },
      (_, i) => `export function Card${i}() { return <div /> }\n`,
    )
    const dir = await project({
      'ui.tsx': `${components.join('')}export const badge = () => <span />\n`,
      'node_modules/pkg/index.ts': 'const lower_case = 1\n',
    })
    const result = await analyze(dir)
    expect(result.conventions?.find((c) => c.kind === 'component')).toMatchObject({
      dominant: 'PascalCase',
      total: 11,
    })
    expect(result.issues?.map((i) => i.rule)).toEqual(['naming/component'])
  })
})

describe('go', () => {
  test('exported names and local variables', async () => {
    const consts = Array.from(
      { length: 10 },
      (_, i) => `const Limit${String.fromCodePoint(65 + i)} = ${i}\n`,
    ).join('')
    const locals = Array.from(
      { length: 10 },
      (_, i) => `\tlocalValue${i} := ${i}\n\t_ = localValue${i}\n`,
    ).join('')
    const dir = await project({
      'limits.go': `package limits\n\n${consts}const MAX_RETRIES = 3\n`,
      'run.go': `package limits\n\nfunc run() int {\n${locals}\tretry_count := 1\n\treturn retry_count + MAX_RETRIES\n}\n`,
    })
    const result = await analyze(dir)
    const exported = result.issues?.find((i) => i.rule === 'naming/exported-constant')
    expect(exported).toMatchObject({ file: 'limits.go', help: 'Rename to `MaxRetries`' })
    expect(exported?.changeId).toBeUndefined()

    const local = result.issues?.find((i) => i.rule === 'naming/local-variable')
    expect(local?.changeId).toBeDefined()
    const files = await applied(dir, result)
    expect(files['run.go']).toContain('\tretryCount := 1\n\treturn retryCount + MAX_RETRIES\n')
  })
})

describe('python', () => {
  test('snake_case functions, private constants and locals', async () => {
    const functions = Array.from(
      { length: 10 },
      (_, i) =>
        `def load_part_${i}(path):\n    file_handle = open(path)\n    return file_handle\n\n`,
    ).join('')
    const constantsPy = twelve.map((name, i) => `${name} = ${i}\n`).join('')
    const dir = await project({
      'app.py': `${constantsPy}_retryCount = 3\n\n${functions}def loadAll(items):\n    resultList = [load_part_0(i) for i in items]\n    return resultList, _retryCount\n`,
    })
    const result = await analyze(dir)
    const rules = result.issues?.map((i) => [i.rule, i.help]) ?? []
    expect(rules).toContainEqual(['naming/function', 'Rename to `load_all`'])
    expect(rules).toContainEqual(['naming/module-constant', 'Rename to `_RETRY_COUNT`'])
    expect(rules).toContainEqual(['naming/local-variable', 'Rename to `result_list`'])
    expect(result.issues?.find((i) => i.rule === 'naming/function')?.changeId).toBeUndefined()

    const text = (await applied(dir, result))['app.py']
    expect(text).toContain('_RETRY_COUNT = 3\n')
    expect(text).toContain(
      'def loadAll(items):\n    result_list = [load_part_0(i) for i in items]\n    return result_list, _RETRY_COUNT\n',
    )
  })
})

describe('listing', () => {
  test('uses git when the directory is a work tree', async () => {
    const dir = await project({ 'tracked.ts': 'const a_b = 1\n', 'ignored.ts': 'const c_d = 1\n' })
    const runner: QualityContext['runner'] = {
      run: async () => ({ exitCode: 0, stdout: 'tracked.ts\0', stderr: '' }),
    }
    const result = await conventionsCheck().run({ dir, runner })
    expect(result.conventions?.find((c) => c.kind === 'module constant')?.total).toBe(1)
  })

  test('detects supported files', async () => {
    expect(await conventionsCheck().detect(await project({ 'main.go': 'package main\n' }))).toBe(
      true,
    )
    expect(await conventionsCheck().detect(await project({ 'README.md': '# x\n' }))).toBe(false)
  })
})
