import type { CodeChange, Edit } from '@holtkeeper/changes'
import type { RepoRef } from '@holtkeeper/forge'
import { z } from 'zod'

import { jsonSplices } from './json-edit.ts'
import { describeDifference, type Difference, subsetDifferences } from './subset.ts'
import { normalizeNewlines, type Splice, splicesToEdits } from './text.ts'
import type { ConventionMode, ConventionStatus } from './types.ts'
import { yamlSplices } from './yaml-edit.ts'

/**
 * One golden file every repository of a group should match:
 * - `exact`: the whole file, ignoring line endings and trailing blank lines;
 * - `json-subset` / `yaml-subset`: every key and array item the golden content defines;
 * - `lines-present`: every non-blank line of the golden content, in any order.
 */
export interface ConventionSpec {
  /** File path in each repository. */
  path: string
  mode: ConventionMode
  /** The golden content. */
  content: string
  /** Suggest creating the file where it is missing. Default `true`. */
  create: boolean
}

export const conventionModes = ['exact', 'json-subset', 'yaml-subset', 'lines-present'] as const

/** Validates `conventions` entries of the `stack` analyzer's options. */
export const conventionSpecSchema = z.object({
  path: z.string().trim().min(1).describe('File path in each repository, e.g. .nvmrc'),
  mode: z
    .enum(conventionModes)
    .default('exact')
    .describe(
      'exact: the whole file; json-subset / yaml-subset: the keys the golden content defines; lines-present: each of its lines',
    ),
  content: z
    .string()
    .min(1)
    .describe('The golden content repositories should match')
    .meta({ 'x-multiline': true }),
  create: z.boolean().default(true).describe('Suggest creating the file where it is missing'),
})

/** Outcome of comparing one file with one convention, before it is tied to a repository. */
export interface Comparison {
  status: ConventionStatus
  problems: string[]
  /** Edits that make the file match; absent when matching or not fixable automatically. */
  edits?: Edit[]
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const parseJson = (text: string): unknown => Bun.JSONC.parse(text)
const parseYaml = (text: string): unknown => Bun.YAML.parse(text)

function subsetComparison(
  spec: ConventionSpec,
  golden: string,
  actual: string,
  parse: (text: string) => unknown,
  splicesOf: (text: string, differences: Difference[]) => Splice[] | undefined,
): Comparison {
  let expected: unknown
  try {
    expected = parse(golden)
  } catch (error) {
    return { status: 'error', problems: [`golden content does not parse: ${errorMessage(error)}`] }
  }
  let found: unknown
  try {
    found = parse(actual)
  } catch (error) {
    return { status: 'error', problems: [`file does not parse: ${errorMessage(error)}`] }
  }
  const differences = subsetDifferences(expected, found)
  if (differences.length === 0) return { status: 'matches', problems: [] }
  const problems = differences.map(describeDifference)
  let splices: Splice[] | undefined
  try {
    splices = splicesOf(actual, differences)
  } catch {
    splices = undefined
  }
  if (!splices?.length)
    return { status: 'drifts', problems: [...problems, 'cannot be fixed automatically'] }
  return { status: 'drifts', problems, edits: splicesToEdits(spec.path, actual, splices) }
}

const requiredLines = (golden: string) =>
  golden
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

function linesComparison(spec: ConventionSpec, golden: string, actual: string): Comparison {
  const present = new Set(actual.split('\n').map((line) => line.trim()))
  const missing = requiredLines(golden).filter((line) => !present.has(line))
  if (missing.length === 0) return { status: 'matches', problems: [] }
  const prefix = actual === '' || actual.endsWith('\n') ? '' : '\n'
  return {
    status: 'drifts',
    problems: missing.map((line) => `missing line ${line}`),
    edits: splicesToEdits(spec.path, actual, [
      { start: actual.length, end: actual.length, newText: `${prefix}${missing.join('\n')}\n` },
    ]),
  }
}

const ensureNewline = (text: string) => (text.endsWith('\n') ? text : `${text}\n`)

/** Compares a repository file (`undefined` when missing) with its convention. Pure. */
export function compareWithConvention(
  spec: ConventionSpec,
  actual: string | undefined,
): Comparison {
  const golden = normalizeNewlines(spec.content)
  if (actual === undefined) {
    const content =
      spec.mode === 'lines-present' ? requiredLines(golden).join('\n') : golden.trimEnd()
    return {
      status: 'missing',
      problems: ['file is missing'],
      ...(spec.create
        ? { edits: [{ kind: 'create', file: spec.path, newText: ensureNewline(content) }] }
        : {}),
    }
  }
  if (spec.mode === 'lines-present') return linesComparison(spec, golden, actual)
  if (spec.mode === 'json-subset')
    return subsetComparison(spec, golden, actual, parseJson, jsonSplices)
  if (spec.mode === 'yaml-subset')
    return subsetComparison(spec, golden, actual, parseYaml, yamlSplices)
  const text = normalizeNewlines(actual)
  if (text.trimEnd() === golden.trimEnd()) return { status: 'matches', problems: [] }
  const before = text.trimEnd().split('\n')
  const after = golden.trimEnd().split('\n')
  const differing =
    Math.max(before.length, after.length) - before.filter((line, i) => line === after[i]).length
  return {
    status: 'drifts',
    problems: [`${differing} of ${after.length} lines differ from the golden file`],
    edits: splicesToEdits(spec.path, actual, [
      { start: 0, end: actual.length, newText: ensureNewline(golden.trimEnd()) },
    ]),
  }
}

/** Short stable hash for change ids. */
const hash = (text: string) => Bun.hash(text).toString(36)

/** A `CodeChange` targeting `repo` from a comparison's edits; `undefined` when there are none. */
export function conventionChange(
  repo: RepoRef,
  spec: ConventionSpec,
  comparison: Comparison,
): CodeChange | undefined {
  if (!comparison.edits?.length) return undefined
  const creates = comparison.edits.every((edit) => edit.kind === 'create')
  return {
    id: `stack:${repo.path}:${spec.path}:${hash(JSON.stringify(comparison.edits))}`,
    title: creates
      ? `Add ${spec.path} from the team convention`
      : `Align ${spec.path} with the team convention`,
    description: comparison.problems.join('\n'),
    confidence: 'review',
    source: 'stack',
    target: repo,
    edits: comparison.edits,
  }
}
