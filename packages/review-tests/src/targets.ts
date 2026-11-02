import { join } from 'node:path'

import { stableId } from '@holtkeeper/quality'
import {
  type SourceFunction,
  type TestConventions,
  type TestFramework,
  type TestLanguage,
  type TestSetup,
  findFunctions,
  frameworkFor,
  isComponentFile,
  isExcludedByName,
  isGeneratedSource,
  isTestFile,
  isTypeOnlySource,
  languageOf,
} from '@holtkeeper/quality-tests'
import type { FileScope } from '@holtkeeper/review'

/** A function the merge request changes that should get a test. */
export interface TestTarget {
  /** Stable for the same function across runs. */
  id: string
  path: string
  symbol: string
  kind: SourceFunction['kind']
  startLine: number
  endLine: number
  /** In-scope added lines inside the function. */
  added: number
  branches: number
  /** Hash of the function's text. */
  hash: string
  language: TestLanguage
  framework: TestFramework
  conventions: TestConventions
}

/** A changed function that gets no test, and why. */
export interface NotTested {
  path: string
  symbol: string
  reason: string
}

export const targetId = (path: string, symbol: string) => stableId('review-tests', path, symbol)

/** Hash of lines `startLine..endLine` (1-based, inclusive) of `text`. */
export function functionHash(text: string, fn: Pick<SourceFunction, 'startLine' | 'endLine'>) {
  const body = text
    .split('\n')
    .slice(fn.startLine - 1, fn.endLine)
    .join('\n')
  return new Bun.CryptoHasher('sha256').update(body).digest('hex').slice(0, 16)
}

/** Functions of a file without those nested in another one; tests reach inner ones through it. */
export function outermost(functions: readonly SourceFunction[]): SourceFunction[] {
  return functions.filter(
    (fn) =>
      !functions.some(
        (other) =>
          other !== fn &&
          other.startLine <= fn.startLine &&
          other.endLine >= fn.endLine &&
          (other.startLine < fn.startLine || other.endLine > fn.endLine),
      ),
  )
}

async function readText(path: string): Promise<string | undefined> {
  const file = Bun.file(path)
  return (await file.exists()) ? file.text() : undefined
}

/**
 * The outermost functions of source files in scope that contain at least `minLines` in-scope added
 * lines, most added lines first, then most branches. Test, generated, excluded, type-only and,
 * unless `components`, component files are left out silently; functions in a language without a detected framework are `notTested`.
 */
export async function findTargets(options: {
  dir: string
  files: readonly Pick<FileScope, 'path' | 'status' | 'lines'>[]
  setup: TestSetup
  minLines: number
  /** Consider component files (`.tsx`, `.jsx`) too. Default false. */
  components?: boolean
}): Promise<{ targets: TestTarget[]; notTested: NotTested[] }> {
  const targets: TestTarget[] = []
  const notTested: NotTested[] = []
  for (const file of options.files) {
    const language = languageOf(file.path)
    if (!language || file.status === 'deleted' || file.lines.size === 0) continue
    if (isTestFile(file.path) || isExcludedByName(file.path)) continue
    if (!options.components && isComponentFile(file.path)) continue
    // oxlint-disable-next-line no-await-in-loop
    const text = await readText(join(options.dir, file.path))
    if (text === undefined || isGeneratedSource(text)) continue
    if (language === 'js' && /\.[cm]?tsx?$/.test(file.path) && isTypeOnlySource(text)) continue

    const changed = outermost(findFunctions(text, language)).flatMap((fn) => {
      let added = 0
      for (const line of file.lines) if (line >= fn.startLine && line <= fn.endLine) added++
      return added >= options.minLines ? [{ fn, added }] : []
    })
    if (!changed.length) continue
    const framework = frameworkFor(options.setup, language)
    const conventions = options.setup.conventions.find((entry) => entry.language === language)
    if (!framework || !conventions) {
      for (const { fn } of changed)
        notTested.push({
          path: file.path,
          symbol: fn.name,
          reason: `no ${language} test framework detected`,
        })
      continue
    }
    for (const { fn, added } of changed)
      targets.push({
        id: targetId(file.path, fn.name),
        path: file.path,
        symbol: fn.name,
        kind: fn.kind,
        startLine: fn.startLine,
        endLine: fn.endLine,
        added,
        branches: fn.branches,
        hash: functionHash(text, fn),
        language,
        framework,
        conventions,
      })
  }
  targets.sort((a, b) => b.added - a.added || b.branches - a.branches)
  return { targets, notTested }
}
