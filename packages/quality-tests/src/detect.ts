import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { isTestFile, languageOf, listFiles } from './files.ts'
import type {
  DetectedFramework,
  TestConventions,
  TestFramework,
  TestLanguage,
  TestLayout,
  TestSetup,
} from './types.ts'

const LANGUAGE: Record<TestFramework, TestLanguage> = {
  'bun:test': 'js',
  vitest: 'js',
  jest: 'js',
  mocha: 'js',
  'node:test': 'js',
  'go test': 'go',
  pytest: 'python',
}

const IMPORT_PATTERNS: [TestFramework, RegExp][] = [
  ['bun:test', /from\s+['"]bun:test['"]/],
  ['vitest', /from\s+['"]vitest['"]/],
  [
    'jest',
    /from\s+['"]@jest\/globals['"]|require\(['"]@jest\/globals['"]\)|\bjest\.(?:fn|mock|spyOn)\(/,
  ],
  ['node:test', /from\s+['"](?:node:)?test['"]|require\(['"](?:node:)?test['"]\)/],
  ['mocha', /from\s+['"]mocha['"]|require\(['"]mocha['"]\)/],
  ['pytest', /^\s*(?:import pytest|from pytest\b)|@pytest\./m],
]

const FRAMEWORK_IMPORT =
  /^import\s+.*from\s+['"](?:bun:test|vitest|@jest\/globals|node:test|mocha)['"];?\s*$/m
const LOCAL_IMPORT = /(?:from\s+|import\(|require\()['"](\.\.?\/[^'"]+)['"]/g

class Signals {
  readonly scores = new Map<TestFramework, { score: number; evidence: string[] }>()

  add(framework: TestFramework, score: number, evidence: string) {
    const entry = this.scores.get(framework) ?? { score: 0, evidence: [] }
    entry.score += score
    entry.evidence.push(evidence)
    this.scores.set(framework, entry)
  }

  ranked(): DetectedFramework[] {
    return [...this.scores]
      .filter(([, entry]) => entry.score > 0)
      .toSorted((a, b) => b[1].score - a[1].score)
      .map(([framework, entry]) => ({
        framework,
        language: LANGUAGE[framework],
        evidence: entry.evidence,
      }))
  }
}

async function readText(path: string, limit = 64 * 1024): Promise<string | undefined> {
  try {
    const text = await readFile(path, 'utf8')
    return text.length > limit ? text.slice(0, limit) : text
  } catch {
    return undefined
  }
}

const baseName = (file: string) => file.slice(file.lastIndexOf('/') + 1)

function packageSignals(signals: Signals, file: string, json: unknown) {
  if (typeof json !== 'object' || json === null) return
  const record: Record<string, unknown> = { ...json }
  const deps = new Set<string>()
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const value = record[field]
    if (typeof value === 'object' && value !== null)
      for (const name of Object.keys(value)) deps.add(name)
  }
  const depFrameworks: [string, TestFramework][] = [
    ['vitest', 'vitest'],
    ['jest', 'jest'],
    ['ts-jest', 'jest'],
    ['@jest/globals', 'jest'],
    ['mocha', 'mocha'],
    ['@types/bun', 'bun:test'],
    ['bun-types', 'bun:test'],
  ]
  for (const [dep, framework] of depFrameworks) {
    if (deps.has(dep))
      signals.add(framework, dep.includes('bun') ? 1 : 3, `${file} depends on ${dep}`)
  }
  const scripts = record['scripts']
  if (typeof scripts !== 'object' || scripts === null) return
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string' || !/test/.test(name + command)) continue
    const scriptFrameworks: [RegExp, TestFramework][] = [
      [/\bbun\s+test\b/, 'bun:test'],
      [/\bvitest\b/, 'vitest'],
      [/\bjest\b/, 'jest'],
      [/\bmocha\b/, 'mocha'],
      [/\bnode\b.*\s--test\b/, 'node:test'],
    ]
    for (const [pattern, framework] of scriptFrameworks) {
      if (pattern.test(command)) signals.add(framework, 3, `${file} script "${name}": ${command}`)
    }
  }
}

function majority<T>(values: readonly T[], fallback: T): T {
  const counts = new Map<T, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best = fallback
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

function layoutOf(file: string): { layout: TestLayout; testDir?: string } {
  const segments = file.split('/').slice(0, -1)
  if (segments.includes('__tests__')) return { layout: '__tests__', testDir: '__tests__' }
  const testDir = segments.find((segment) => segment === 'test' || segment === 'tests')
  return testDir ? { layout: 'test-dir', testDir } : { layout: 'colocated' }
}

function jsConventions(
  tests: readonly string[],
  sources: readonly string[],
  contents: Map<string, string>,
): TestConventions {
  const layouts = tests.map(layoutOf)
  const layout = majority(
    layouts.map((entry) => entry.layout),
    'colocated',
  )
  const testDir = majority(
    layouts
      .filter((entry) => entry.layout === layout && entry.testDir)
      .map((entry) => entry.testDir ?? ''),
    layout === '__tests__' ? '__tests__' : 'test',
  )
  const suffixes = tests
    .map((file) => /\.(test|spec)\.[^.]+$/.exec(baseName(file))?.[1])
    .filter(Boolean)
  const suffix = tests.length && !suffixes.length ? '' : `.${majority(suffixes, 'test')}`
  const extensions = (tests.length ? tests : sources).map(
    (file) => /\.[cm]?[jt]sx?$/.exec(file)?.[0] ?? '.ts',
  )
  const extension = majority(
    extensions.map((ext) => (ext === '.tsx' || ext === '.jsx' ? ext.slice(0, -1) : ext)),
    '.ts',
  )

  const imports: string[] = []
  const localExtensions: ('.ts' | '.js' | 'none')[] = []
  for (const file of tests) {
    const text = contents.get(file)
    if (!text) continue
    const line = FRAMEWORK_IMPORT.exec(text)?.[0]
    if (line) imports.push(line.trim().replace(/;$/, ''))
    for (const match of text.matchAll(LOCAL_IMPORT)) {
      const spec = match[1] ?? ''
      localExtensions.push(
        /\.[cm]?tsx?$/.test(spec) ? '.ts' : /\.[cm]?jsx?$/.test(spec) ? '.js' : 'none',
      )
    }
  }

  const conventions: TestConventions = {
    language: 'js',
    layout,
    fileName: `{name}${suffix}${extension}`,
  }
  if (layout !== 'colocated') conventions.testDir = testDir
  if (imports.length) conventions.frameworkImport = majority(imports, imports[0] ?? '')
  if (localExtensions.length) conventions.localImportExtension = majority(localExtensions, 'none')
  return conventions
}

function pythonConventions(tests: readonly string[]): TestConventions {
  const layouts = tests.map(layoutOf)
  const layout = tests.length
    ? majority(
        layouts.map((entry) => entry.layout),
        'test-dir',
      ) === 'colocated'
      ? 'colocated'
      : 'test-dir'
    : 'test-dir'
  const suffixStyle = majority(
    tests.map((file) => (baseName(file).startsWith('test_') ? 'prefix' : 'suffix')),
    'prefix',
  )
  const conventions: TestConventions = {
    language: 'python',
    layout,
    fileName: suffixStyle === 'prefix' ? 'test_{name}.py' : '{name}_test.py',
  }
  if (layout === 'test-dir') {
    conventions.testDir = majority(
      layouts.map((entry) => entry.testDir ?? '').filter(Boolean),
      'tests',
    )
  }
  return conventions
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function pickSamples(
  tests: readonly string[],
  sizes: Map<string, number>,
  matches: (file: string) => boolean,
): string[] {
  const score = (file: string) => {
    const size = sizes.get(file) ?? 0
    return (matches(file) ? 0 : 10_000) + (size < 300 ? 5000 : 0) + Math.abs(size - 2500) / 10
  }
  const ordered = [...tests].toSorted((a, b) => score(a) - score(b) || a.localeCompare(b))
  const picked: string[] = []
  const dirs = new Set<string>()
  for (const file of ordered) {
    const dir = file.slice(0, file.lastIndexOf('/') + 1)
    if (dirs.has(dir)) continue
    dirs.add(dir)
    picked.push(file)
    if (picked.length === 3) return picked
  }
  for (const file of ordered) {
    if (picked.length === 3) break
    if (!picked.includes(file)) picked.push(file)
  }
  return picked
}

/**
 * Finds the project's test frameworks from package manifests, config files and the imports of
 * existing tests, and learns where tests live, how they are named and how they import, with a
 * few existing tests to imitate. Reads files only; runs nothing.
 */
export async function detectTestSetup(dir: string): Promise<TestSetup> {
  const files = await listFiles(dir)
  const signals = new Signals()
  const tests = files.filter(
    (file) => isTestFile(file) && languageOf(file) && baseName(file) !== 'conftest.py',
  )
  const testsByLanguage = (language: TestLanguage) =>
    tests.filter((file) => languageOf(file) === language)
  const jsTests = testsByLanguage('js')
  const goTests = testsByLanguage('go')
  const pyTests = testsByLanguage('python')

  for (const file of files.filter((path) => baseName(path) === 'package.json')) {
    // oxlint-disable-next-line no-await-in-loop
    const text = await readText(join(dir, file))
    if (!text) continue
    try {
      packageSignals(signals, file, JSON.parse(text))
    } catch {
      // malformed manifest: no signal
    }
  }

  for (const file of files) {
    const name = baseName(file)
    if (/^vitest\.(config|workspace)\.[cm]?[jt]s$/.test(name))
      signals.add('vitest', 3, `config ${file}`)
    else if (/^jest\.config\.[cm]?[jt]s(on)?$/.test(name)) signals.add('jest', 3, `config ${file}`)
    else if (/^\.mocharc(\.[a-z]+)?$/.test(name)) signals.add('mocha', 3, `config ${file}`)
    else if (name === 'pytest.ini' || name === 'conftest.py')
      signals.add('pytest', 3, `config ${file}`)
    else if (name === 'go.mod') signals.add('go test', goTests.length ? 3 : 1, `module ${file}`)
    else if (name === 'bunfig.toml') {
      // oxlint-disable-next-line no-await-in-loop
      if (/^\[test\]/m.test((await readText(join(dir, file))) ?? ''))
        signals.add('bun:test', 2, `${file} [test]`)
    } else if (name === 'pyproject.toml' || name === 'setup.cfg' || name === 'tox.ini') {
      // oxlint-disable-next-line no-await-in-loop
      const text = (await readText(join(dir, file))) ?? ''
      if (/^\[(tool\.pytest|tool:pytest|pytest)/m.test(text))
        signals.add('pytest', 3, `${file} pytest section`)
      else if (/\bpytest\b/.test(text)) signals.add('pytest', 2, `${file} mentions pytest`)
    } else if (/^requirements.*\.txt$/.test(name)) {
      // oxlint-disable-next-line no-await-in-loop
      if (/^pytest\b/m.test((await readText(join(dir, file))) ?? ''))
        signals.add('pytest', 2, `${file} lists pytest`)
    }
  }
  if (
    jsTests.length &&
    ((await exists(join(dir, 'bun.lock'))) || (await exists(join(dir, 'bun.lockb'))))
  ) {
    signals.add('bun:test', 1, 'bun lockfile')
  }
  if (goTests.length) signals.add('go test', 1, `${goTests.length} *_test.go files`)
  if (pyTests.length)
    signals.add(
      'pytest',
      1,
      `${pyTests.length} Python test files (pytest also runs unittest tests)`,
    )

  const contents = new Map<string, string>()
  const sizes = new Map<string, number>()
  const importsBy = new Map<string, TestFramework>()
  const counts = new Map<TestFramework, number>()
  for (const file of [...jsTests, ...pyTests].slice(0, 200)) {
    // oxlint-disable-next-line no-await-in-loop
    const text = await readText(join(dir, file))
    if (text === undefined) continue
    contents.set(file, text)
    sizes.set(file, text.length)
    const found = IMPORT_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0]
    if (found) {
      importsBy.set(file, found)
      counts.set(found, (counts.get(found) ?? 0) + 1)
    }
  }
  for (const [framework, count] of counts) {
    signals.add(
      framework,
      Math.min(2 * count, 20),
      `${count} test file${count === 1 ? '' : 's'} use ${framework}`,
    )
  }
  for (const file of goTests.slice(0, 50)) {
    try {
      // oxlint-disable-next-line no-await-in-loop
      sizes.set(file, (await stat(join(dir, file))).size)
    } catch {
      // vanished
    }
  }

  const frameworks = signals.ranked()
  const sources = files.filter((file) => languageOf(file) === 'js' && !isTestFile(file))
  const conventions: TestConventions[] = []
  const languages = new Set([
    ...frameworks.map((entry) => entry.language),
    ...tests.map((file) => languageOf(file)),
  ])
  if (languages.has('js')) conventions.push(jsConventions(jsTests, sources, contents))
  if (languages.has('go'))
    conventions.push({ language: 'go', layout: 'colocated', fileName: '{name}_test.go' })
  if (languages.has('python')) conventions.push(pythonConventions(pyTests))

  const primary = frameworks[0]
  const samples = primary
    ? pickSamples(
        testsByLanguage(primary.language),
        sizes,
        (file) =>
          primary.language === 'go' ||
          importsBy.get(file) === primary.framework ||
          !importsBy.has(file),
      )
    : []
  return { frameworks, conventions, samples, testFiles: tests.length }
}

/** The framework new tests in `language` should use: the best-ranked one for that language. */
export function frameworkFor(setup: TestSetup, language: TestLanguage): TestFramework | undefined {
  return setup.frameworks.find((entry) => entry.language === language)?.framework
}
