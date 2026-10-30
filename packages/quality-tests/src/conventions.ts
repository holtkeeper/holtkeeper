import { posix } from 'node:path'

import type { TestConventions, TestFramework } from './types.ts'

function sourceName(file: string): string {
  const base = posix.basename(file)
  return base.replace(/\.[^.]+$/, '')
}

const join = (...parts: string[]) => posix.join(...parts.filter((part) => part && part !== '.'))

/** Where a new test for `sourceFile` goes under the project's conventions (relative path). */
export function testPathFor(conventions: TestConventions, sourceFile: string): string {
  const name = conventions.fileName.replace('{name}', sourceName(sourceFile))
  const dir = posix.dirname(sourceFile)
  if (conventions.layout === 'colocated') return join(dir, name)
  if (conventions.layout === '__tests__') return join(dir, conventions.testDir ?? '__tests__', name)

  const testDir = conventions.testDir ?? (conventions.language === 'python' ? 'tests' : 'test')
  if (conventions.language === 'python') {
    const root = dir.split('/').slice(0, -1).join('/')
    return join(root, testDir, name)
  }
  // `packages/x/src/a/b.ts` → `packages/x/test/a/b.test.ts`; without `src/`, next to the root.
  const segments = dir === '.' ? [] : dir.split('/')
  const src = segments.lastIndexOf('src')
  if (src === -1) return join(testDir, ...segments, name)
  return join(...segments.slice(0, src), testDir, ...segments.slice(src + 1), name)
}

/**
 * Checks that `testPath` is a test file name the project's framework picks up and sits where the
 * project keeps tests for `sourceFile`. Returns why not, or `undefined` when it fits.
 */
export function testPathProblem(
  conventions: TestConventions,
  sourceFile: string,
  testPath: string,
): string | undefined {
  if (!testPath || posix.isAbsolute(testPath) || testPath.includes('\\'))
    return 'path must be relative and use /'
  const normalized = posix.normalize(testPath)
  if (normalized !== testPath || normalized.startsWith('..'))
    return 'path must be normalized and stay inside the project'
  const base = posix.basename(testPath)
  const dir = posix.dirname(testPath)
  const sourceDir = posix.dirname(sourceFile)
  const segments = dir.split('/')

  switch (conventions.language) {
    case 'go':
      if (!base.endsWith('_test.go')) return 'Go tests must end with _test.go'
      if (dir !== sourceDir) return `Go tests must be in the package directory ${sourceDir}`
      return undefined
    case 'python':
      if (!/^test_.+\.py$/.test(base) && !base.endsWith('_test.py'))
        return 'Python tests must be named test_*.py or *_test.py'
      break
    case 'js': {
      const named = /\.(test|spec)\.[cm]?[jt]sx?$/.test(base)
      if (
        !named &&
        !(
          conventions.layout === '__tests__' &&
          segments.includes('__tests__') &&
          /\.[cm]?[jt]sx?$/.test(base)
        )
      ) {
        return `test files must be named like ${conventions.fileName}`
      }
      break
    }
  }

  if (conventions.layout === 'colocated' && dir !== sourceDir)
    return `tests live next to the source, in ${sourceDir}`
  if (conventions.layout === '__tests__' && posix.basename(dir) !== '__tests__')
    return 'tests live in a __tests__ folder'
  if (conventions.layout === 'test-dir') {
    const testDir = conventions.testDir ?? 'test'
    if (!segments.includes(testDir)) return `tests live in a ${testDir}/ folder`
  }
  return undefined
}

/** Command that runs only the given test file (or, for Go, its package), from the project root. */
export function singleTestCommand(framework: TestFramework, testPath: string): string[] {
  switch (framework) {
    case 'bun:test':
      return ['bun', 'test', `./${testPath}`]
    case 'vitest':
      return ['npx', '--no-install', 'vitest', 'run', testPath]
    case 'jest':
      return ['npx', '--no-install', 'jest', testPath]
    case 'mocha':
      return ['npx', '--no-install', 'mocha', testPath]
    case 'node:test':
      return ['node', '--test', testPath]
    case 'go test':
      return ['go', 'test', `./${posix.dirname(testPath)}`]
    case 'pytest':
      return ['python3', '-m', 'pytest', testPath]

    default:
      throw new Error(`unsupported framework ${String(framework)}`)
  }
}
