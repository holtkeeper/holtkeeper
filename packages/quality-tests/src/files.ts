import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { TestLanguage } from './types.ts'

/** Dependency, build and data folders; hidden folders are skipped too. */
const IGNORED_DIRS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  'venv',
  '__pycache__',
  'site-packages',
  'testdata',
  'fixtures',
])

const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

/** Language family of a source file by extension; `undefined` for anything else. */
export function languageOf(file: string): TestLanguage | undefined {
  if (file.endsWith('.d.ts') || file.endsWith('.d.mts') || file.endsWith('.d.cts')) return undefined
  if (JS_EXTENSIONS.some((ext) => file.endsWith(ext))) return 'js'
  if (file.endsWith('.go')) return 'go'
  if (file.endsWith('.py')) return 'python'
  return undefined
}

/** Whether a path is a test file by the naming conventions of the supported frameworks. */
export function isTestFile(file: string): boolean {
  const name = file.slice(file.lastIndexOf('/') + 1)
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return true
  if (name.endsWith('_test.go')) return true
  if (/^test_.*\.py$/.test(name) || name.endsWith('_test.py') || name === 'conftest.py') return true
  return /(^|\/)__tests__\//.test(file) && languageOf(file) === 'js'
}

/** Files that are not worth testing: configs, declarations, generated or vendored code by name. */
export function isExcludedByName(file: string): boolean {
  const name = file.slice(file.lastIndexOf('/') + 1)
  if (/\.d\.[cm]?ts$/.test(name)) return true
  if (/\.config\.[cm]?[jt]s$/.test(name) || /^\..*rc\.[cm]?[jt]s$/.test(name)) return true
  if (/\.(generated|gen)\.[cm]?[jt]sx?$/.test(name) || name.endsWith('.min.js')) return true
  if (/(_gen|\.pb|_string|_mock|\.pb\.gw)\.go$/.test(name)) return true
  if (/_pb2(_grpc)?\.py$/.test(name) || name === 'setup.py' || name === 'conftest.py') return true
  return false
}

/** Whether the file announces itself as generated in its first lines. */
export function isGeneratedSource(text: string): boolean {
  const head = text.slice(0, 1000)
  return (
    /Code generated .* DO NOT EDIT/.test(head) ||
    /@generated\b/.test(head) ||
    /auto-?generated/i.test(head)
  )
}

const LIST_LIMIT = 20_000

/** Whether `listFiles` would list a path, i.e. no folder on it is skipped. */
export function isListable(file: string): boolean {
  return file
    .split('/')
    .slice(0, -1)
    .every((segment) => !IGNORED_DIRS.has(segment) && !segment.startsWith('.'))
}

/**
 * Lists files under `dir` as `/`-separated relative paths, skipping dependency, build and VCS
 * folders and hidden folders. Stops after `limit` files (default 20 000).
 */
export async function listFiles(dir: string, limit = LIST_LIMIT): Promise<string[]> {
  const files: string[] = []
  const queue: string[] = ['']
  while (queue.length && files.length < limit) {
    const rel = queue.shift() ?? ''
    let entries
    try {
      // oxlint-disable-next-line no-await-in-loop
      entries = await readdir(join(dir, rel), { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(path)
      } else if (entry.isFile()) {
        files.push(path)
        if (files.length >= limit) break
      }
    }
  }
  return files
}
