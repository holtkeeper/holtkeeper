import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type CodeChange,
  type InlineSvgFinding,
  inlineSyntaxOf,
  optimizeInlineSvgs,
  rangeOf,
} from '@holtkeeper/media'

import type { Finding, InlineSvgData } from './data.ts'
import { defaultIgnore, scanFiles } from './inventory.ts'
import { generatedIgnore } from './references.ts'

/** Files whose inline SVGs are checked. */
export const inlineSvgPatterns = ['**/*.{html,htm,jsx,tsx,vue,svelte,astro}']

const MAX_SOURCE_BYTES = 2 * 1024 * 1024

export interface InlineSvgResult {
  inlineSvgs: InlineSvgData[]
  findings: Finding[]
  changes: CodeChange[]
}

/** Data, a finding and a change for the fragments of one file. */
export function inlineSvgFile(
  file: string,
  text: string,
  fragments: readonly InlineSvgFinding[],
): InlineSvgResult {
  if (!fragments.length) return { inlineSvgs: [], findings: [], changes: [] }
  const id = `assets:inline-svg:${file}`
  const before = fragments.reduce((sum, fragment) => sum + fragment.bytes.before, 0)
  const after = fragments.reduce((sum, fragment) => sum + fragment.bytes.after, 0)
  const count = `${fragments.length} inline SVG${fragments.length === 1 ? '' : 's'}`
  const whole = fragments.every((fragment) => fragment.kind === 'svg')
  return {
    inlineSvgs: fragments.map((fragment) => ({
      file,
      line: fragment.line,
      endLine: fragment.endLine,
      kind: fragment.kind,
      bytes: fragment.bytes,
      digits: fragment.digits,
      paths: fragment.paths,
      changeId: id,
    })),
    findings: [
      {
        id: `inline-svg:${file}`,
        rule: 'inline-svg',
        path: file,
        line: fragments[0]?.line ?? 1,
        tone: 'info',
        title: `${count} in ${file} could be ${before - after} bytes smaller`,
        detail: whole
          ? 'Editor metadata, comments and excess decimals are removed with svgo (safe preset); ids, classes and styles stay.'
          : 'Path data keeps more decimals than any screen shows; only the `d` values are rewritten, everything else stays as written.',
      },
    ],
    changes: [
      {
        id,
        title: `Optimize ${count} in ${file}`,
        description: `${before} → ${after} bytes of SVG markup, path digits ${fragments.reduce((sum, f) => sum + f.digits.before, 0)} → ${fragments.reduce((sum, f) => sum + f.digits.after, 0)}`,
        confidence: whole ? 'safe' : 'review',
        source: 'svgo',
        edits: fragments.map((fragment) => ({
          kind: 'replace',
          file,
          range: rangeOf(text, fragment.start, fragment.end),
          oldText: fragment.oldText,
          newText: fragment.newText,
        })),
      },
    ],
  }
}

/**
 * Inline `<svg>` and `<path>` elements of markup and component files that svgo makes noticeably
 * smaller, as data, one `inline-svg` finding and one change per file. Never writes to `dir`.
 */
export async function scanInlineSvgs(options: {
  dir: string
  ignore?: readonly string[]
  minSaving?: number
}): Promise<InlineSvgResult> {
  const files = await scanFiles(options.dir, inlineSvgPatterns, [
    ...defaultIgnore,
    ...generatedIgnore,
    ...(options.ignore ?? []),
  ])
  const result: InlineSvgResult = { inlineSvgs: [], findings: [], changes: [] }
  for (const file of files) {
    const syntax = inlineSyntaxOf(file)
    if (!syntax) continue
    const content = await readFile(join(options.dir, file))
    if (content.byteLength > MAX_SOURCE_BYTES) continue
    const text = content.toString('utf8')
    if (!/<(?:svg|path)\b/.test(text)) continue
    const fragments = optimizeInlineSvgs(text, {
      syntax,
      ...(options.minSaving === undefined ? {} : { minSaving: options.minSaving }),
    })
    const part = inlineSvgFile(file, text, fragments)
    result.inlineSvgs.push(...part.inlineSvgs)
    result.findings.push(...part.findings)
    result.changes.push(...part.changes)
  }
  return result
}
