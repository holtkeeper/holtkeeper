import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { type Evidence, approx, collectGeneral } from '@holtkeeper/guide-generator'

/**
 * One fact the model reads and cites by `id`. `path` is the repository file it comes from, so a
 * lesson citing it can link that file.
 */
export interface BootstrapEvidence extends Evidence {
  path?: string
}

/** Most characters of all code evidence together. */
export const CODE_CHARS = 18_000
/** Most characters of the README item. */
export const README_CHARS = 3_000
/** Most characters of one docs file item. */
export const DOC_CHARS = 1_500
/** Most docs files besides the README. */
export const DOC_FILES = 3
/** Most ADR items, and characters of the text under each one's title. */
export const ADR_FILES = 6
export const ADR_CHARS = 400
/** Most characters of the Go package layout item. */
export const GO_LAYOUT_CHARS = 1_200

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 4).trimEnd()}\n...`

async function readText(dir: string, file: string, limit = 64 * 1024) {
  try {
    const text = await readFile(join(dir, file), 'utf8')
    return text.length > limit ? text.slice(0, limit) : text
  } catch {
    return undefined
  }
}

const depth = (file: string) => file.split('/').length - 1
const base = (file: string) => file.slice(file.lastIndexOf('/') + 1)
const isMarkdown = (file: string) => /\.(md|mdx)$/i.test(file)
const isAdr = (file: string) =>
  isMarkdown(file) && /(^|\/)(adr|adrs|decisions|decision-records)\//i.test(file)

/** README text without badges, HTML comments and HTML-only lines, blank runs collapsed. */
export function trimReadme(text: string): string {
  return text
    .replaceAll(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (/^(\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*|!\[[^\]]*\]\([^)]*\)\s*)+$/.test(trimmed))
        return false
      return !/^<\/?[a-z][^>]*>$/i.test(trimmed)
    })
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()
}

const byPath = (a: string, b: string) => a.length - b.length || a.localeCompare(b)

const DOC_NAMES = /^(CONTRIBUTING|ARCHITECTURE|DEVELOPMENT|DEVELOPING|HACKING|DESIGN)(\.[a-z]+)?$/i

/**
 * Docs files worth reading besides the README, best first: root CONTRIBUTING, ARCHITECTURE,
 * DEVELOPMENT and the like, then Markdown under `docs/` (ADRs left out), shortest path first.
 */
export function pickDocs(files: readonly string[], limit = DOC_FILES): string[] {
  const root = files.filter((file) => depth(file) === 0 && DOC_NAMES.test(base(file)))
  const nested = files.filter(
    (file) => /^docs?\//i.test(file) && isMarkdown(file) && !isAdr(file) && depth(file) <= 3,
  )
  return [...root.toSorted(byPath), ...nested.toSorted(byPath)].slice(0, limit)
}

/** Packages under `cmd/`, `internal/` and `pkg/` (two levels) with their Go file counts. */
export function goLayout(files: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const file of files) {
    if (!file.endsWith('.go')) continue
    const parts = file.split('/')
    if (!['cmd', 'internal', 'pkg'].includes(parts[0] ?? '') || parts.length < 3) continue
    const key = parts.slice(0, Math.min(parts.length - 1, 3)).join('/')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return clip(
    [...counts]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([folder, count]) => `${folder}: ${approx(count)} Go files`)
      .join('\n'),
    GO_LAYOUT_CHARS,
  )
}

/**
 * Deterministic code evidence for starter knowledge: the Guide generator's general evidence
 * (`collectGeneral`: manifests, Makefile targets, CI, lint, toolchain, layout, docs list), the
 * README without badges, up to `DOC_FILES` docs files, up to `ADR_FILES` ADRs (title and opening)
 * and, for Go modules, the package layout. Items are cut to their caps and the list to
 * `CODE_CHARS` (later items dropped first). `files` lists the checkout, repository-relative.
 */
export async function collectCodeEvidence(
  dir: string,
  files: readonly string[],
): Promise<BootstrapEvidence[]> {
  const all = [...files].toSorted()
  const items: BootstrapEvidence[] = [...(await collectGeneral(dir, all))]

  const readme = all.find((file) => depth(file) === 0 && /^readme(\.md|\.markdown)?$/i.test(file))
  const readmeText = readme ? trimReadme((await readText(dir, readme)) ?? '') : ''
  if (readme && readmeText)
    items.push({
      id: `file:${readme}`,
      label: readme,
      text: clip(readmeText, README_CHARS),
      path: readme,
    })

  for (const file of pickDocs(all)) {
    // oxlint-disable-next-line no-await-in-loop -- a few small files, in a stable order
    const text = (await readText(dir, file))?.trim()
    if (text)
      items.push({ id: `file:${file}`, label: file, text: clip(text, DOC_CHARS), path: file })
  }

  for (const file of all.filter(isAdr).slice(0, ADR_FILES)) {
    // oxlint-disable-next-line no-await-in-loop -- see above
    const text = (await readText(dir, file, 8 * 1024))?.trim()
    if (!text) continue
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? base(file)
    const rest = text.replace(/^#\s+.+$/m, '').trim()
    items.push({
      id: `file:${file}`,
      label: `ADR: ${title}`,
      text: clip(rest, ADR_CHARS),
      path: file,
    })
  }

  if (all.includes('go.mod')) {
    const layout = goLayout(all)
    if (layout) items.push({ id: 'go-layout', label: 'Go packages', text: layout })
  }

  const kept: BootstrapEvidence[] = []
  let total = 0
  for (const item of items) {
    if (total + item.text.length > CODE_CHARS) continue
    total += item.text.length
    kept.push(item)
  }
  return kept
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Modules a `go.mod` requires directly (`// indirect` lines left out). */
export function goRequires(text: string): string[] {
  const modules: string[] = []
  let block = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (block) {
      if (line.startsWith(')')) {
        block = false
        continue
      }
      if (line && !line.startsWith('//') && !line.includes('// indirect'))
        modules.push(line.split(/\s+/)[0] ?? '')
      continue
    }
    if (/^require\s*\($/.test(line)) block = true
    else if (/^require\s+\S+\s+\S+/.test(line) && !line.includes('// indirect'))
      modules.push(line.split(/\s+/)[1] ?? '')
  }
  return modules.filter(Boolean)
}

/**
 * Subjects (`Go:<module>`, `npm:<name>`) of the repository's direct dependencies: the root
 * `go.mod` requires and the dependencies of every `package.json` up to two folders deep.
 */
export async function directDependencies(
  dir: string,
  files: readonly string[],
): Promise<Set<string>> {
  const subjects = new Set<string>()
  if (files.includes('go.mod'))
    for (const module of goRequires((await readText(dir, 'go.mod')) ?? ''))
      subjects.add(`Go:${module}`)
  const manifests = files.filter(
    (file) => base(file) === 'package.json' && depth(file) <= 2 && !file.includes('node_modules/'),
  )
  for (const file of manifests) {
    let manifest: unknown
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few small files
      manifest = JSON.parse((await readText(dir, file)) ?? '')
    } catch {
      continue
    }
    if (!isRecord(manifest)) continue
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = manifest[field]
      if (isRecord(deps)) for (const name of Object.keys(deps)) subjects.add(`npm:${name}`)
    }
  }
  return subjects
}
