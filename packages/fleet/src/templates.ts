import type { CodeChange, Edit } from '@holtkeeper/changes'
import type { RepoRef } from '@holtkeeper/forge'
import { z } from 'zod'

import { jsonSplices } from './json-edit.ts'
import { describeDifference, type Difference, subsetDifferences } from './subset.ts'
import { normalizeNewlines, type Splice, splicesToEdits } from './text.ts'
import type { TemplateMode, TemplateStatus } from './types.ts'
import { yamlSplices } from './yaml-edit.ts'

/** A required line matched by regular expression, e.g. a Dockerfile base image. */
export interface LinePattern {
  /** Regular expression a line must match. */
  pattern: string
  /** Line to add when none matches; without it the problem is reported but not fixed. */
  line?: string
  /** Regular expression of the line that `line` replaces, e.g. `^FROM node:`; appended otherwise. */
  replaces?: string
}

/** Where a template's content comes from: a file of another repository (`forge:path`), or inline. */
export type TemplateSource = { repo: string; file?: string; ref?: string } | { content: string }

/** One golden file every repository of the group should match. */
export interface TemplateSpec {
  /** File path in each repository. */
  path: string
  source?: TemplateSource
  mode: TemplateMode
  /** Suggest creating the file where it is missing. Default `true`. */
  create: boolean
  /** Extra required lines for `lines-present`, besides the source's lines. */
  lines?: (string | LinePattern)[]
}

/** Validates `templates` entries from config. */
export const templateSpecSchema: z.ZodType<TemplateSpec> = z
  .object({
    path: z.string().min(1),
    source: z
      .union([
        z.object({
          repo: z.string().min(1),
          file: z.string().optional(),
          ref: z.string().optional(),
        }),
        z.object({ content: z.string() }),
      ])
      .optional(),
    mode: z.enum(['exact', 'json-subset', 'yaml-subset', 'lines-present']).default('exact'),
    create: z.boolean().default(true),
    lines: z
      .array(
        z.union([
          z.string(),
          z.object({
            pattern: z.string().min(1),
            line: z.string().optional(),
            replaces: z.string().optional(),
          }),
        ]),
      )
      .optional(),
  })
  .refine((spec) => spec.source || (spec.mode === 'lines-present' && spec.lines?.length), {
    message: 'a template needs a source, or `lines` in lines-present mode',
  })

/** Outcome of comparing one file with one template, before it is tied to a repository. */
export interface Comparison {
  status: TemplateStatus
  problems: string[]
  /** Edits that make the file match; absent when matching or not fixable automatically. */
  edits?: Edit[]
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const parseJson = (text: string): unknown => Bun.JSONC.parse(text)
const parseYaml = (text: string): unknown => Bun.YAML.parse(text)

function subsetComparison(
  spec: TemplateSpec,
  template: string,
  actual: string,
  parse: (text: string) => unknown,
  splicesOf: (text: string, differences: Difference[]) => Splice[] | undefined,
): Comparison {
  let expected: unknown
  try {
    expected = parse(template)
  } catch (error) {
    return { status: 'error', problems: [`template does not parse: ${errorMessage(error)}`] }
  }
  let found: unknown
  try {
    found = parse(actual)
  } catch (error) {
    return { status: 'error', problems: [`file does not parse: ${errorMessage(error)}`] }
  }
  const differences = subsetDifferences(expected, found)
  if (differences.length === 0) return { status: 'identical', problems: [] }
  const problems = differences.map(describeDifference)
  let splices: Splice[] | undefined
  try {
    splices = splicesOf(actual, differences)
  } catch {
    splices = undefined
  }
  if (!splices?.length)
    return { status: 'drifted', problems: [...problems, 'cannot be fixed automatically'] }
  return { status: 'drifted', problems, edits: splicesToEdits(spec.path, actual, splices) }
}

interface Requirement {
  test(line: string): boolean
  label: string
  line?: string
  replaces?: RegExp
}

const literal = (text: string): Requirement => ({
  test: (line) => line.trim() === text.trim(),
  label: text.trim(),
  line: text.trim(),
})

function requirements(spec: TemplateSpec, template: string | undefined): Requirement[] {
  const fromTemplate = (template ?? '')
    .split('\n')
    .filter((line) => line.trim())
    .map(literal)
  const extra = (spec.lines ?? []).map((entry) => {
    if (typeof entry === 'string') return literal(entry)
    const regexp = new RegExp(entry.pattern)
    return {
      test: (line: string) => regexp.test(line),
      label: `/${entry.pattern}/`,
      ...(entry.line ? { line: entry.line } : {}),
      ...(entry.replaces ? { replaces: new RegExp(entry.replaces) } : {}),
    }
  })
  return [...fromTemplate, ...extra]
}

function linesComparison(
  spec: TemplateSpec,
  template: string | undefined,
  actual: string,
): Comparison {
  const lines = actual.split('\n')
  const missing = requirements(spec, template).filter(
    (requirement) => !lines.some((line) => requirement.test(line)),
  )
  if (missing.length === 0) return { status: 'identical', problems: [] }
  const problems = missing.map((requirement) => `missing line ${requirement.label}`)
  const splices: Splice[] = []
  const appended: string[] = []
  const offsets = lines.reduce<number[]>(
    (all, line, index) => [
      ...all,
      index === 0 ? 0 : all[index - 1]! + lines[index - 1]!.length + 1,
    ],
    [],
  )
  const replaced = new Set<number>()
  let fixable = true
  for (const requirement of missing) {
    if (requirement.line === undefined) {
      fixable = false
      continue
    }
    const index = requirement.replaces
      ? lines.findIndex((line, i) => !replaced.has(i) && requirement.replaces!.test(line))
      : -1
    if (index === -1) appended.push(requirement.line)
    else {
      replaced.add(index)
      const start = offsets[index]!
      const end = start + lines[index]!.replace(/\r$/, '').length
      splices.push({ start, end, newText: requirement.line })
    }
  }
  if (appended.length) {
    const end = actual.length
    const prefix = actual === '' || actual.endsWith('\n') ? '' : '\n'
    splices.push({ start: end, end, newText: `${prefix}${appended.join('\n')}\n` })
  }
  if (!fixable) problems.push('some lines cannot be added automatically')
  return {
    status: 'drifted',
    problems,
    ...(splices.length ? { edits: splicesToEdits(spec.path, actual, splices) } : {}),
  }
}

const ensureNewline = (text: string) => (text.endsWith('\n') ? text : `${text}\n`)

/** Content to create a missing file with, or `undefined` when it cannot be derived. */
function initialContent(spec: TemplateSpec, template: string | undefined): string | undefined {
  if (spec.mode !== 'lines-present')
    return template === undefined ? undefined : ensureNewline(template)
  const required = requirements(spec, template)
  if (required.some((requirement) => requirement.line === undefined)) return undefined
  return ensureNewline(required.map((requirement) => requirement.line).join('\n'))
}

/**
 * Compares a repository file (`undefined` when missing) with its template. Pure: `template` is the
 * already-read template content (`undefined` only for `lines-present` with `lines`).
 */
export function compareWithTemplate(
  spec: TemplateSpec,
  template: string | undefined,
  actual: string | undefined,
): Comparison {
  if (actual === undefined) {
    const content = spec.create ? initialContent(spec, template) : undefined
    return {
      status: 'missing',
      problems: ['file is missing'],
      ...(content === undefined
        ? {}
        : { edits: [{ kind: 'create', file: spec.path, newText: content }] }),
    }
  }
  const expected = template === undefined ? undefined : normalizeNewlines(template)
  const text = normalizeNewlines(actual)
  if (spec.mode === 'lines-present') return linesComparison(spec, expected, actual)
  if (expected === undefined) return { status: 'error', problems: ['template has no content'] }
  if (spec.mode === 'json-subset')
    return subsetComparison(spec, expected, actual, parseJson, jsonSplices)
  if (spec.mode === 'yaml-subset')
    return subsetComparison(spec, expected, actual, parseYaml, yamlSplices)
  if (text.trimEnd() === expected.trimEnd()) return { status: 'identical', problems: [] }
  const before = text.trimEnd().split('\n')
  const after = expected.trimEnd().split('\n')
  const differing =
    Math.max(before.length, after.length) - before.filter((line, i) => line === after[i]).length
  return {
    status: 'drifted',
    problems: [`${differing} of ${after.length} lines differ from the template`],
    edits: splicesToEdits(spec.path, actual, [
      { start: 0, end: actual.length, newText: ensureNewline(expected) },
    ]),
  }
}

/** Short stable hash for change ids. */
const hash = (text: string) => Bun.hash(text).toString(36)

/** A `CodeChange` targeting `repo` from a comparison's edits; `undefined` when there are none. */
export function templateChange(
  repo: RepoRef,
  spec: TemplateSpec,
  comparison: Comparison,
): CodeChange | undefined {
  if (!comparison.edits?.length) return undefined
  const creates = comparison.edits.every((edit) => edit.kind === 'create')
  return {
    id: `fleet:${repo.path}:${spec.path}:${hash(JSON.stringify(comparison.edits))}`,
    title: creates
      ? `Add ${spec.path} from the fleet template`
      : `Align ${spec.path} with the fleet template`,
    description: comparison.problems.join('\n'),
    confidence: 'review',
    source: 'fleet',
    target: repo,
    edits: comparison.edits,
  }
}
