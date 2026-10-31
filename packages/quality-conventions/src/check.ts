import { join } from 'node:path'

import { parse } from '@ast-grep/napi'
import type { CodeChange, Range } from '@holtkeeper/changes'
import { stableId } from '@holtkeeper/quality'
import type { ConventionStat, QualityCheck, QualityIssue, QualityResult } from '@holtkeeper/quality'

import { fitsCase, toCase } from './case.ts'
import { type DeclaredName, collectNames } from './collect.ts'
import { registerLanguages } from './dynamic.ts'
import { walkFiles, listFiles } from './files.ts'
import { type ConventionThresholds, inferConvention } from './infer.ts'
import { defaultLanguages } from './languages/index.ts'
import type { LanguageSpec, SourceFile } from './languages/types.ts'
import { renameEdits } from './rename.ts'

const TOOL = 'conventions'

/** Options of `conventionsCheck`. */
export interface ConventionsOptions extends ConventionThresholds {
  /** Languages to analyze; default `defaultLanguages`. */
  languages?: readonly LanguageSpec[]
  /** Whether file names are analyzed as their own kind. Default true. */
  fileNames?: boolean
  /** Files larger than this are skipped (generated or minified code). Default 512 KiB. */
  maxFileBytes?: number
  /** At most this many source files are analyzed. Default 10 000. */
  maxFiles?: number
  /** Share from which outliers are reported as `warning` instead of `info`. Default 0.95. */
  warningShare?: number
}

interface Sample {
  path: string
  name: string
  range?: Range
  /** Index into `collectNames` of the file; absent for file names. */
  index?: number
  renamable: boolean
}

interface Group {
  language: string
  id: string
  label: string
  spec?: LanguageSpec
  samples: Sample[]
}

function specFor(languages: readonly LanguageSpec[], path: string): LanguageSpec | undefined {
  const extension = /\.([^./]+)$/.exec(path)?.[1]
  return extension ? languages.find((spec) => spec.extensions.includes(extension)) : undefined
}

function toRange({
  start,
  end,
}: {
  start: { line: number; column: number }
  end: { line: number; column: number }
}): Range {
  return {
    start: { line: start.line + 1, column: start.column + 1 },
    end: { line: end.line + 1, column: end.column + 1 },
  }
}

const capitalize = (text: string) => (text[0]?.toUpperCase() ?? '') + text.slice(1)
const kebab = (label: string) => label.replaceAll(/\s+/g, '-')
const plural = (label: string) => (label.endsWith(' name') ? `${label}s` : `${label} names`)

async function readSource(
  dir: string,
  path: string,
  spec: LanguageSpec,
  maxBytes: number,
): Promise<SourceFile | undefined> {
  try {
    const handle = Bun.file(join(dir, path))
    if (handle.size > maxBytes) return undefined
    const text = await handle.text()
    const parser = spec.parser(path)
    return { path, parser, text, root: parse(parser, text).root() }
  } catch {
    return undefined
  }
}

/**
 * The `conventions` quality check: infers how each kind of name (module constants, local
 * variables, components, types, file names, ... per language) is written in the project and
 * reports names that break an established convention. A file named after a name it declares
 * (`UserCard.tsx` declaring `UserCard`) follows that name's convention and is left out of file
 * names. Outliers that are not visible outside
 * their file get a rename suggestion (`confidence: review`) covering every reference in scope.
 */
export function conventionsCheck(options: ConventionsOptions = {}): QualityCheck {
  const {
    languages = defaultLanguages,
    fileNames = true,
    maxFileBytes = 512 * 1024,
    maxFiles = 10_000,
    warningShare = 0.95,
  } = options

  return {
    name: TOOL,

    async detect(dir) {
      try {
        for await (const path of walkFiles(dir)) if (specFor(languages, path)) return true
      } catch {
        return false
      }
      return false
    },

    async run({ dir, runner, signal }): Promise<QualityResult> {
      const paths = (await listFiles(dir, runner, signal))
        .filter((path) => specFor(languages, path))
        .toSorted()
        .slice(0, maxFiles)
      const available = await registerLanguages(languages)
      const usable = (spec: LanguageSpec, path: string) =>
        !spec.dynamic || available.has(String(spec.parser(path)))

      const groups = new Map<string, Group>()
      const groupOf = (language: string, id: string, label: string, spec?: LanguageSpec) => {
        const key = `${language}\0${id}`
        let group = groups.get(key)
        if (!group)
          groups.set(key, (group = { language, id, label, ...(spec ? { spec } : {}), samples: [] }))
        return group
      }

      for (const path of paths) {
        signal?.throwIfAborted()
        const spec = specFor(languages, path)
        if (!spec || !usable(spec, path)) continue
        // Files are parsed one at a time to keep a single syntax tree in memory.
        // oxlint-disable-next-line no-await-in-loop
        const file = await readSource(dir, path, spec, maxFileBytes)
        if (!file) continue
        const declaredNames = collectNames(spec, file)
        declaredNames.forEach((declared, index) => {
          groupOf(spec.id, declared.kind.id, declared.kind.label, spec).samples.push({
            path,
            name: declared.name,
            range: toRange(declared.node.range()),
            index,
            renamable: declared.scope !== 'none',
          })
        })
        const fileKind = fileNames ? (spec.fileNameKind?.(path) ?? 'file name') : undefined
        const stem = /(?:^|\/)([^./][^./]*)[^/]*$/.exec(path)?.[1]
        const namedAfterDeclaration = declaredNames.some((declared) => declared.name === stem)
        if (fileKind && stem && !namedAfterDeclaration)
          groupOf(spec.id, kebab(fileKind), fileKind).samples.push({
            path,
            name: stem,
            renamable: false,
          })
      }

      const conventions: ConventionStat[] = []
      const issues: QualityIssue[] = []
      const renames: { sample: Sample; group: Group; newName: string; issue: QualityIssue }[] = []

      for (const group of groups.values()) {
        const inferred = inferConvention(
          group.samples.map((sample) => sample.name),
          options,
        )
        if (!inferred) continue
        const { dominant, share, total, outliers, established } = inferred
        conventions.push({
          language: group.language,
          kind: group.label,
          dominant,
          share,
          total,
          outliers: outliers.length,
          established,
        })
        if (!established) continue

        const rule = `naming/${group.id}`
        const ordinals = new Map<string, number>()
        for (const index of outliers) {
          const sample = group.samples[index]
          if (!sample) continue
          const key = `${sample.path}\0${sample.name}`
          const ordinal = ordinals.get(key) ?? 0
          ordinals.set(key, ordinal + 1)
          const suggestion = toCase(sample.name, dominant)
          const fits = suggestion !== sample.name && fitsCase(suggestion, dominant)
          const fitting = Math.round(share * total)
          const issue: QualityIssue = {
            id: stableId(TOOL, rule, sample.path, sample.name, ordinal),
            tool: TOOL,
            rule,
            category: 'convention',
            severity: share >= warningShare ? 'warning' : 'info',
            message: `${capitalize(group.label)} \`${sample.name}\` does not follow the project's ${dominant} (${fitting} of ${total} ${plural(group.label)})`,
            file: sample.path,
            ...(sample.range ? { range: sample.range } : {}),
            ...(fits ? { help: `Rename to \`${suggestion}\`` } : {}),
          }
          issues.push(issue)
          if (fits && sample.renamable) renames.push({ sample, group, newName: suggestion, issue })
        }
      }

      const changes = await suggestRenames(dir, renames, maxFileBytes)
      return { conventions, issues, changes }
    },
  }
}

async function suggestRenames(
  dir: string,
  renames: readonly { sample: Sample; group: Group; newName: string; issue: QualityIssue }[],
  maxFileBytes: number,
): Promise<CodeChange[]> {
  const changes: CodeChange[] = []
  const byFile = Map.groupBy(renames, (rename) => rename.sample.path)
  for (const [path, items] of byFile) {
    const spec = items[0]?.group.spec
    if (!spec) continue
    // oxlint-disable-next-line no-await-in-loop
    const file = await readSource(dir, path, spec, maxFileBytes)
    if (!file) continue
    const names: DeclaredName[] = collectNames(spec, file)
    for (const { sample, newName, issue } of items) {
      const declared = sample.index === undefined ? undefined : names[sample.index]
      if (!declared || declared.name !== sample.name) continue
      const edits = renameEdits(spec, file, declared, newName, names)
      if (!edits) continue
      const id = stableId(TOOL, 'rename', issue.id, newName)
      changes.push({
        id,
        title: `Rename \`${sample.name}\` to \`${newName}\``,
        description: issue.message,
        confidence: 'review',
        source: TOOL,
        edits,
      })
      issue.changeId = id
    }
  }
  return changes
}
