import { stat } from 'node:fs/promises'
import { join, posix } from 'node:path'

import type { Toolset } from '@holtkeeper/agent'
import {
  type JsWorkspaces,
  declaredDependencies,
  indexLockfile,
  lockfileOf,
  readJsWorkspaces,
  workspacesOf,
} from '@holtkeeper/depgraph-js'
import { parseGoMod, parseGoSum } from '@holtkeeper/go-source'
import { z } from 'zod'

import {
  LOCKFILE_NAMES,
  MAX_READ_BYTES,
  formatSize,
  insideDir,
  listFiles,
  relativePath,
} from './files.ts'
import { ToolError, defineTool } from './tool.ts'

/** Lockfiles reported per call when no path narrows the search. */
const MAX_LOCKFILES = 8
/** Importer lines reported per lockfile. */
const MAX_IMPORTERS = 15

const isGoPath = (name: string) => !name.startsWith('@') && name.includes('/')

const dirOf = (path: string) => {
  const dir = posix.dirname(path)
  return dir === '.' ? '' : dir
}

const covers = (dir: string, target: string) =>
  dir === '' || target === dir || target.startsWith(`${dir}/`)

async function readLarge(path: string): Promise<{ text: string; size: number } | string> {
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) return 'missing'
  if (info.size > MAX_READ_BYTES) return `${formatSize(info.size)}, too large to read`
  return { text: await Bun.file(path).text(), size: info.size }
}

async function workspacesAt(dir: string): Promise<JsWorkspaces> {
  try {
    return await readJsWorkspaces(dir)
  } catch {
    return workspacesOf(new Map())
  }
}

async function resolveInJsLockfile(dir: string, file: string, name: string): Promise<string[]> {
  const lockfile = lockfileOf(file)
  if (!lockfile) return []
  const read = await readLarge(join(dir, file))
  if (typeof read === 'string') return [`${file}: ${read}`]
  const workspaces = await workspacesAt(join(dir, dirOf(file)))
  let index
  try {
    index = indexLockfile(lockfile, read.text, workspaces)
  } catch (error) {
    return [
      `${file} (${lockfile.manager}, ${formatSize(read.size)}): could not parse: ${error instanceof Error ? error.message : String(error)}`,
    ]
  }
  const out = [`${file} (${lockfile.manager} lockfile, ${formatSize(read.size)}, parsed in full)`]
  const versions = index.packages.get(name)
  out.push(
    versions
      ? `  resolved versions: ${versions.join(', ')}`
      : `  ${name} is not present in this lockfile (${index.packages.size} packages)`,
  )
  const declared = new Map(
    [workspaces.root, ...workspaces.packages].flatMap((workspace) =>
      declaredDependencies(workspace.manifest)
        .filter((dep) => dep.name === name)
        .slice(0, 1)
        .map((dep) => [workspace.path, dep] as const),
    ),
  )
  const paths = [
    ...new Set([
      ...declared.keys(),
      ...[...index.importers.values()]
        .filter((importer) => importer.dependencies.has(name))
        .map((importer) => importer.path),
    ]),
  ].toSorted()
  for (const path of paths.slice(0, MAX_IMPORTERS)) {
    const dep = declared.get(path)
    const locked = index.importers.get(path)?.dependencies.get(name)
    const manifest = posix.join(dirOf(file), path, 'package.json')
    const lockSide = locked?.version
      ? `lockfile ${locked.specifier ? `records ${locked.specifier}, ` : ''}resolves ${locked.version}`
      : 'the lockfile does not resolve it'
    out.push(
      dep
        ? `  ${manifest}: ${dep.kind} ${dep.range}; ${lockSide}`
        : `  ${manifest}: not declared; ${lockSide}`,
    )
  }
  if (paths.length > MAX_IMPORTERS) out.push(`  … ${paths.length - MAX_IMPORTERS} more workspaces`)
  if (!versions) {
    const lower = name.toLowerCase()
    const similar = [...index.packages.keys()]
      .filter((candidate) => candidate.toLowerCase().includes(lower))
      .slice(0, 5)
    if (similar.length) out.push(`  similar names: ${similar.join(', ')}`)
  }
  return out
}

async function resolveInGoModule(dir: string, goMod: string, name: string): Promise<string[]> {
  const read = await readLarge(join(dir, goMod))
  if (typeof read === 'string') return [`${goMod}: ${read}`]
  const mod = parseGoMod(read.text)
  const sumFile = posix.join(dirOf(goMod), 'go.sum')
  const sum = await readLarge(join(dir, sumFile))
  const entries = typeof sum === 'string' ? [] : parseGoSum(sum.text)
  const owns = (path: string) => name === path || name.startsWith(`${path}/`)
  const out = [`${goMod} (module ${mod.module || 'unnamed'})`]
  if (owns(mod.module)) out.push(`  ${name} belongs to this module itself`)
  const required = mod.require.filter((req) => owns(req.path))
  if (!required.length && !owns(mod.module)) out.push(`  ${name} is not required by go.mod`)
  for (const req of required) {
    out.push(`  requires ${req.path} ${req.version}${req.indirect ? ' (indirect)' : ''}`)
    for (const replace of mod.replace.filter(
      (r) => r.path === req.path && (!r.version || r.version === req.version),
    ))
      out.push(`  replaced by ${replace.to}${replace.toVersion ? ` ${replace.toVersion}` : ''}`)
  }
  const modules = new Set([...required.map((req) => req.path), ...(owns(mod.module) ? [] : [name])])
  const byVersion = new Map<string, Set<string>>()
  for (const entry of entries)
    if (modules.has(entry.path))
      byVersion.set(
        `${entry.path} ${entry.version}`,
        (byVersion.get(`${entry.path} ${entry.version}`) ?? new Set()).add(entry.kind),
      )
  if (typeof sum === 'string') out.push(`  ${sumFile}: ${sum}`)
  else if (byVersion.size)
    out.push(
      `  ${sumFile} (${formatSize(sum.size)}, parsed in full): ${[...byVersion]
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, kinds]) => `${key} (${[...kinds].toSorted().join(' + ')})`)
        .join(', ')}`,
    )
  else if (required.length) out.push(`  ${sumFile} has no entry for it`)
  return out
}

/**
 * The `lockfiles` toolset: `lockfiles.resolve` answers which versions the repository's lockfiles
 * (`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`) and Go
 * module files (`go.mod`, `go.sum`) resolve for one package, parsing each file in full whatever
 * its size, so agents never grep a lockfile. Confined to the task directory.
 */
export function lockfileTools(): Toolset {
  return {
    name: 'lockfiles',
    instructions:
      'Lockfiles are usually too large or marked binary for the search tools and the diff. Check which version of a package a lockfile resolves with lockfiles.resolve instead of grepping it.',
    tools: [
      defineTool({
        name: 'lockfiles.resolve',
        description:
          'Which versions the lockfiles (package-lock.json, npm-shrinkwrap.json, yarn.lock, pnpm-lock.yaml, bun.lock) or go.mod/go.sum resolve for a package, with the range each package.json declares and whether the lockfile matches it. Lockfiles are parsed in full whatever their size; "not present" is a real answer. Use it instead of grepping lockfiles.',
        input: z.object({
          package: z
            .string()
            .min(1)
            .describe('npm package name ("some-lib", "@scope/name") or Go module or package path'),
          path: z
            .string()
            .optional()
            .describe(
              'Workspace or module directory (or a file in it) to check the nearest lockfile of; default every lockfile in the repository',
            ),
        }),
        subject: ({ package: name }) => name,
        async run({ package: name, path }, { dir, signal }) {
          const target = path ? relativePath(dir, insideDir(dir, path)) : ''
          const go = isGoPath(name)
          const names = go ? ['go.mod'] : LOCKFILE_NAMES.filter((file) => file !== 'go.sum')
          let files = await listFiles(dir, {
            globs: names.flatMap((file) => [file, `**/${file}`]),
            signal,
          })
          if (path) {
            const nearest = files
              .map(dirOf)
              .filter((lockDir) => covers(lockDir, target))
              .toSorted((a, b) => b.length - a.length)[0]
            files = nearest === undefined ? [] : files.filter((file) => dirOf(file) === nearest)
          }
          if (!files.length)
            throw new ToolError(
              `no ${go ? 'go.mod' : 'npm, yarn, pnpm or bun lockfile'} ${path ? `covers ${path}` : 'in the repository'}`,
            )
          const shown = files.slice(0, MAX_LOCKFILES)
          const blocks = await Promise.all(
            shown.map((file) =>
              go ? resolveInGoModule(dir, file, name) : resolveInJsLockfile(dir, file, name),
            ),
          )
          const more =
            files.length > shown.length
              ? [`… ${files.length - shown.length} more lockfiles; pass path to pick one`]
              : []
          return [...blocks.map((block) => block.join('\n')), ...more].join('\n\n')
        },
      }),
    ],
  }
}
