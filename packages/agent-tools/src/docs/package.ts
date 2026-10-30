import { readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import type { AgentTool, Toolset } from '@holtkeeper/agent'
import type { CommandRunner } from '@holtkeeper/exec'
import { z } from 'zod'

import { type Budget, budgetOf, clip, limitLines } from '../budget.ts'
import { formatEntry, outline, parseSource } from '../code/syntax.ts'
import { insideDir, readText, splitLines } from '../files.ts'
import { defineTool } from '../tool.ts'
import { releases, releasesBetween, sections } from './markdown.ts'

const NPM_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i
const GO_PATH = /^[\w.~-]+(?:\/[\w.~-]+)*$/

const DOC_FILES = {
  readme: [/^readme(\.md|\.markdown|\.txt)?$/i],
  changelog: [/^(changelog|changes|history|releases)(\.md|\.markdown)?$/i],
  migration: [/^(migration|migrating|upgrading|upgrade)(\.md|\.markdown)?$/i, /^migration.*\.md$/i],
} as const

type DocKind = keyof typeof DOC_FILES
const DOC_KINDS: readonly DocKind[] = ['readme', 'changelog', 'migration']

async function findDoc(root: string, kind: DocKind): Promise<string | undefined> {
  const candidates = [root, join(root, 'docs')]
  for (const dir of candidates) {
    let names: string[]
    try {
      names = (await readdir(dir)).toSorted()
    } catch {
      continue
    }
    for (const pattern of DOC_FILES[kind]) {
      const name = names.find((candidate) => pattern.test(candidate))
      if (name) return join(dir, name)
    }
  }
  return undefined
}

interface Located {
  root: string
  /** How the package root is shown to the model. */
  label: string
  version?: string
  manifest?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await Bun.file(path).json()
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** `node_modules/<name>` nearest to `start`, looking upwards but never above `dir`. */
async function locateNpm(dir: string, start: string, name: string): Promise<Located | undefined> {
  let current = start
  for (;;) {
    const root = join(current, 'node_modules', name)
    const manifest = await readJson(join(root, 'package.json'))
    if (manifest) {
      const version = typeof manifest['version'] === 'string' ? manifest['version'] : undefined
      return {
        root,
        label: relative(dir, root).split('\\').join('/'),
        manifest,
        ...(version ? { version } : {}),
      }
    }
    if (resolve(current) === resolve(dir)) return undefined
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function locateGo(
  runner: CommandRunner,
  dir: string,
  name: string,
  signal: AbortSignal,
): Promise<Located | undefined> {
  const result = await runner.run(['go', 'list', '-m', '-f', '{{.Dir}}|{{.Version}}', name], {
    cwd: dir,
    signal,
    timeoutMs: 60_000,
  })
  if (result.exitCode !== 0) return undefined
  const [root = '', version = ''] = result.stdout.trim().split('|')
  if (!root) return undefined
  return { root, label: name, ...(version ? { version } : {}) }
}

function typesEntry(manifest: Record<string, unknown> | undefined): string | undefined {
  if (!manifest) return undefined
  for (const key of ['types', 'typings']) {
    const value = manifest[key]
    if (typeof value === 'string') return value
  }
  const find = (value: unknown): string | undefined => {
    if (!isRecord(value)) return undefined
    if (typeof value['types'] === 'string') return value['types']
    for (const key of ['import', 'require', 'default', 'node']) {
      const found = find(value[key])
      if (found) return found
    }
    return undefined
  }
  const exports = manifest['exports']
  const main = isRecord(exports) ? exports['.'] : undefined
  return find(main ?? exports)
}

async function resolveDts(base: string, specifier: string): Promise<string | undefined> {
  const path = resolve(base, specifier)
  const stem = path.replace(/\.(d\.)?[mc]?[jt]s$/, '')
  for (const candidate of [
    path,
    `${stem}.d.ts`,
    `${stem}.d.mts`,
    `${stem}.d.cts`,
    join(path, 'index.d.ts'),
  ])
    if (candidate.endsWith('.ts') && (await Bun.file(candidate).exists())) return candidate
  return undefined
}

/** Outline lines of a declaration file and of the files it re-exports from (one level). */
async function apiOutline(root: string, entry: string, budget: Budget): Promise<string[]> {
  const out: string[] = []
  const visit = async (file: string, followReexports: boolean) => {
    const text = await readText(file)
    if (text === undefined) return
    const tree = parseSource('typescript', text)
    out.push(`# ${relative(root, file).split('\\').join('/')}`)
    out.push(...outline(tree, budget.maxLineLength).map(formatEntry))
    if (!followReexports) return
    for (const node of tree.findAll({
      rule: { kind: 'export_statement', has: { field: 'source', kind: 'string' } },
    })) {
      const specifier = node.field('source')?.text().slice(1, -1)
      if (!specifier?.startsWith('.')) continue
      const target = await resolveDts(dirname(file), specifier)
      if (target) await visit(target, false)
    }
  }
  const start = await resolveDts(root, entry)
  if (start) await visit(start, true)
  return out
}

/** Major versions a heading names; the largest is the version a migration section leads to. */
function majorsIn(title: string): number[] {
  return [...title.matchAll(/\bv?(\d+)(?:\.\d+)*\b/g)].map((match) => Number(match[1]))
}

function major(version: string | undefined): number | undefined {
  const value = version ? Number.parseInt(version.replace(/^v/, ''), 10) : Number.NaN
  return Number.isNaN(value) ? undefined : value
}

function overview(markdown: string, budget: Budget): string[] {
  const all = sections(markdown)
  const lines = splitLines(markdown)
  const firstHeading = all[1]?.line ?? lines.length + 1
  const intro = lines.slice(0, Math.min(firstHeading - 1, 20))
  const toc = all.map(
    (section) => `${'  '.repeat(section.level - 1)}${section.line} ${section.title}`,
  )
  return [
    ...intro.map((line) => clip(line, budget.maxLineLength)),
    ...(toc.length ? ['', 'Sections (pass heading to read one):', ...toc] : []),
  ]
}

const showValues = ['summary', 'readme', 'changelog', 'migration', 'api'] as const

export interface DocsToolsOptions {
  budget?: Partial<Budget>
  /** Runs `go list` and `go doc` for Go modules; without it Go lookups report that they are unavailable. */
  runner?: CommandRunner
}

/** `docs.package`: what the installed version of a dependency documents and exports. */
export function packageDocsTool(options: DocsToolsOptions = {}): AgentTool {
  const budget = budgetOf(options.budget)
  const finish = (lines: string[]) => limitLines(lines, budget.maxResultLines, 'lines').join('\n')
  return defineTool({
    name: 'docs.package',
    description:
      'Documentation of an installed dependency at the version the repository uses. show=summary (default): version, entry points, available docs. show=changelog with from/to: only the release notes between two versions. show=migration: upgrade guide sections between from and to. show=readme: intro and section list, or one section with heading. show=api: exported declarations from its .d.ts (npm) or go doc (Go); heading filters by name. Prefer this over reading node_modules.',
    input: z.object({
      name: z.string().min(1).describe('Package name (npm) or module/package path (Go)'),
      ecosystem: z.enum(['npm', 'go']).optional().describe('Default npm'),
      show: z.enum(showValues).optional(),
      from: z.string().optional().describe('Exclusive lower version for changelog/migration'),
      to: z.string().optional().describe('Inclusive upper version for changelog/migration'),
      heading: z
        .string()
        .optional()
        .describe('README section title, or a name to filter the API by'),
      workspace: z
        .string()
        .optional()
        .describe('Directory the package is resolved from, default the root'),
    }),
    async run(
      { name, ecosystem = 'npm', show = 'summary', from, to, heading, workspace },
      { dir, signal },
    ) {
      let located: Located | undefined
      if (ecosystem === 'npm') {
        if (!NPM_NAME.test(name)) throw new Error(`${name} is not an npm package name`)
        located = await locateNpm(dir, insideDir(dir, workspace ?? '.'), name)
        if (!located) return `${name} is not installed (no node_modules/${name}/package.json)`
      } else {
        if (!GO_PATH.test(name) || name.split('/').includes('..'))
          throw new Error(`${name} is not a Go path`)
        if (!options.runner) return 'Go documentation is not available in this run'
        if (show === 'api') {
          const command = ['go', 'doc', ...(heading ? [name, heading] : ['-short', name])]
          const result = await options.runner.run(command, { cwd: dir, signal, timeoutMs: 60_000 })
          if (result.exitCode !== 0)
            return `go doc failed: ${clip(result.stderr.trim(), budget.maxLineLength)}`
          return finish(splitLines(result.stdout).map((line) => clip(line, budget.maxLineLength)))
        }
        located = await locateGo(options.runner, dir, name, signal)
        if (!located) return `${name} is not a module required by this repository`
      }
      const header = `${name} ${located.version ?? '(version unknown)'} at ${located.label}`

      if (show === 'summary') {
        const manifest = located.manifest
        const docs = (await Promise.all(DOC_KINDS.map((kind) => findDoc(located.root, kind))))
          .filter((path): path is string => Boolean(path))
          .map((path) => relative(located.root, path))
        const description =
          typeof manifest?.['description'] === 'string' ? manifest['description'] : undefined
        const types = typesEntry(manifest)
        return finish([
          header,
          ...(description ? [clip(description, budget.maxLineLength)] : []),
          ...(types ? [`types: ${types}`] : []),
          `docs: ${docs.length ? docs.join(', ') : 'none'}`,
        ])
      }

      if (show === 'api') {
        const entry = typesEntry(located.manifest) ?? 'index.d.ts'
        let lines = await apiOutline(located.root, entry, budget)
        if (lines.length === 0) {
          const typesPackage = name.startsWith('@') ? name.slice(1).replace('/', '__') : name
          return `${header}\nno type declarations (${entry} not found); try @types/${typesPackage}`
        }
        if (heading) {
          const needle = heading.toLowerCase()
          lines = lines.filter(
            (line) => line.startsWith('# ') || line.toLowerCase().includes(needle),
          )
        }
        return finish([header, ...lines])
      }

      const file = await findDoc(located.root, show)
      if (!file) {
        const repository = located.manifest?.['repository']
        const url = isRecord(repository) ? repository['url'] : repository
        return `${header}\nno ${show} file in the package${typeof url === 'string' ? `; see ${url}` : ''}`
      }
      const markdown = (await readText(file)) ?? ''
      const title = `${header} — ${relative(located.root, file)}`

      if (show === 'readme') {
        if (!heading) return finish([title, ...overview(markdown, budget)])
        const needle = heading.toLowerCase()
        const section = sections(markdown).find((candidate) =>
          candidate.title.toLowerCase().includes(needle),
        )
        if (!section) return `${title}\nno section matching "${heading}"`
        return finish([title, ...section.lines.map((line) => clip(line, budget.maxLineLength))])
      }

      if (show === 'changelog') {
        const all = releases(markdown)
        if (all.length === 0)
          return finish([title, 'no versioned headings', ...overview(markdown, budget)])
        const picked =
          from === undefined && to === undefined ? all.slice(0, 3) : releasesBetween(all, from, to)
        if (picked.length === 0)
          return `${title}\nno releases between ${from ?? 'the start'} and ${to ?? 'the latest'}; versions present: ${all
            .slice(0, 10)
            .map((section) => section.version)
            .join(', ')}`
        return finish([
          `${title}: ${picked.length} releases`,
          ...picked.flatMap((section) =>
            section.lines.map((line) => clip(line, budget.maxLineLength)),
          ),
        ])
      }

      const low = major(from)
      const high = major(to)
      const picked =
        low === undefined && high === undefined
          ? []
          : sections(markdown).filter((section) => {
              const target = Math.max(...majorsIn(section.title))
              return (
                Number.isFinite(target) &&
                (low === undefined || target > low) &&
                (high === undefined || target <= high)
              )
            })
      const outer = picked.filter(
        (section) =>
          !picked.some(
            (other) => other.line < section.line && section.line < other.line + other.lines.length,
          ),
      )
      if (outer.length === 0) return finish([title, ...overview(markdown, budget)])
      return finish([
        title,
        ...outer.flatMap((section) =>
          section.lines.map((line) => clip(line, budget.maxLineLength)),
        ),
      ])
    },
  })
}

/** The `docs` toolset: `docs.package`. */
export function docsTools(options: DocsToolsOptions = {}): Toolset {
  return { name: 'docs', tools: [packageDocsTool(options)] }
}
