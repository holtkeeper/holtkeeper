import { optimize } from 'svgo'

import { optimizeSvg, pathStats } from './svg.ts'

/** Markup flavour of a source file, which decides how much of an inline SVG may be rewritten. */
export type InlineSyntax = 'html' | 'jsx' | 'vue' | 'svelte'

export interface InlineSvgOptions {
  syntax: InlineSyntax
  /** Decimals kept in path data. Default 3. */
  precision?: number
  /** Fragments saving fewer bytes are not reported. Default 32. */
  minSaving?: number
}

/** One inline `<svg>` or `<path>` of a source file and its optimized text. */
export interface InlineSvgFinding {
  /**
   * `svg`: a static `<svg>` element rewritten with svgo (safe preset). `paths`: only the `d`
   * values of an element were rewritten, because it has bindings or JSX attributes svgo would drop.
   */
  kind: 'svg' | 'paths'
  /** Offsets of `oldText` in the file. */
  start: number
  end: number
  /** 1-based lines of `start` and of the last character. */
  line: number
  endLine: number
  oldText: string
  newText: string
  bytes: { before: number; after: number }
  /** Digits in path data before and after. */
  digits: { before: number; after: number }
  /** `d` attributes in the fragment. */
  paths: number
}

const SVG_BLOCK = /<svg\b(?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*>[\s\S]*?<\/svg\s*>/g
const PATH_TAG = /<path\b(?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*>/g
const D_ATTRIBUTE =
  /(\sd\s*=\s*)(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)\s*\})/g

/** Vue/Svelte/Angular bindings or template expressions anywhere in the fragment. */
const DYNAMIC = /[{}]|\s(?::|@|v-|#|\*ng|\[)[\w-]/

const lineAt = (text: string, offset: number) => {
  let line = 1
  for (
    let index = text.indexOf('\n');
    index !== -1 && index < offset;
    index = text.indexOf('\n', index + 1)
  )
    line++
  return line
}

const digitsOf = (fragment: string) =>
  [...fragment.matchAll(D_ATTRIBUTE)].reduce((sum, match) => {
    const d = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? ''
    return sum + pathStats([{ name: 'path', attributes: new Map([['d', d]]) }]).digits
  }, 0)

const countPaths = (fragment: string) => [...fragment.matchAll(D_ATTRIBUTE)].length

/**
 * Path data rewritten by svgo's `convertPathData` with `precision` decimals. The wrapper carries
 * round stroke caps, so zero-length segments that draw dots are kept.
 */
export function optimizePathData(d: string, precision = 3): string {
  if (!d.trim() || /[<>"&]/.test(d)) return d
  try {
    const { data } = optimize(
      `<svg xmlns="http://www.w3.org/2000/svg" stroke="#000" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`,
      {
        multipass: true,
        plugins: [{ name: 'convertPathData', params: { floatPrecision: precision } }],
      },
    )
    const optimized = data.match(/\sd="([^"]*)"/)?.[1]
    return optimized && optimized.length < d.length ? optimized : d
  } catch {
    return d
  }
}

/** `fragment` with every literal `d` value optimized, keeping each value's quoting. */
function rewritePaths(fragment: string, precision: number): string {
  return fragment.replace(
    D_ATTRIBUTE,
    (whole, prefix: string, ...groups: (string | undefined)[]) => {
      const index = groups.slice(0, 5).findIndex((group) => group !== undefined)
      const value = groups[index]
      if (value === undefined) return whole
      const optimized = optimizePathData(value, precision)
      if (optimized === value) return whole
      return `${prefix}${whole.slice(prefix.length).replace(value, optimized)}`
    },
  )
}

/** svgo safe preset on a static fragment, or `undefined` when svgo cannot parse it. */
function optimizeStatic(fragment: string, precision: number): string | undefined {
  try {
    const { text } = optimizeSvg(fragment, { preset: 'safe', precision })
    return text.length < fragment.length ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * Inline `<svg>` elements and stray `<path>` elements of a source file that get noticeably
 * smaller. Static SVGs in HTML, Vue and Svelte templates are rewritten whole with svgo's safe
 * preset; SVGs with bindings and every JSX SVG only get their literal `d` values optimized, since
 * svgo does not know JSX attributes or template syntax. Fragments are returned in file order and
 * never overlap; the rest of the file is untouched.
 */
export function optimizeInlineSvgs(text: string, options: InlineSvgOptions): InlineSvgFinding[] {
  const precision = options.precision ?? 3
  const minSaving = options.minSaving ?? 32
  const findings: InlineSvgFinding[] = []
  const covered: [number, number][] = []
  const report = (
    kind: InlineSvgFinding['kind'],
    start: number,
    oldText: string,
    newText: string,
  ) => {
    const saving = oldText.length - newText.length
    if (saving < minSaving || saving < oldText.length * 0.05) return
    const end = start + oldText.length
    findings.push({
      kind,
      start,
      end,
      line: lineAt(text, start),
      endLine: lineAt(text, end - 1),
      oldText,
      newText,
      bytes: { before: Buffer.byteLength(oldText), after: Buffer.byteLength(newText) },
      digits: { before: digitsOf(oldText), after: digitsOf(newText) },
      paths: countPaths(oldText),
    })
  }

  for (const match of text.matchAll(SVG_BLOCK)) {
    const fragment = match[0]
    covered.push([match.index, match.index + fragment.length])
    const whole =
      options.syntax !== 'jsx' && !DYNAMIC.test(fragment)
        ? optimizeStatic(fragment, precision)
        : undefined
    if (whole) report('svg', match.index, fragment, whole)
    else report('paths', match.index, fragment, rewritePaths(fragment, precision))
  }
  for (const match of text.matchAll(PATH_TAG)) {
    if (covered.some(([start, end]) => match.index >= start && match.index < end)) continue
    report('paths', match.index, match[0], rewritePaths(match[0], precision))
  }
  return findings.toSorted((a, b) => a.start - b.start)
}

/** The markup flavour of a file by extension; `undefined` for files without markup. */
export function inlineSyntaxOf(file: string): InlineSyntax | undefined {
  if (/\.(?:jsx|tsx)$/i.test(file)) return 'jsx'
  if (/\.vue$/i.test(file)) return 'vue'
  if (/\.svelte$/i.test(file)) return 'svelte'
  if (/\.(?:html?|astro|hbs|ejs|njk|php|erb)$/i.test(file)) return 'html'
  return undefined
}
