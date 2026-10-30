// oxlint-disable no-await-in-loop -- steps touch the same checkout or forge branch and run in order
import { join, relative } from 'node:path'

import type { GitForge } from '@holtkeeper/forge'

import { globToRegExp } from './semver.ts'
import type { PackageTarget, RepoFiles, RepoPlan, Usage } from './types.ts'
import {
  goModUsages,
  goWorkDirs,
  packageJsonUsages,
  packageJsonWorkspaces,
  pnpmWorkspacePatterns,
  pnpmWorkspaceUsages,
} from './usages.ts'

/** Plans one repository: which manifests declare which target, and what the bump would write. */
export interface Planner {
  plan(files: RepoFiles, targets: PackageTarget[]): Promise<RepoPlan>
}

/** Repository files through the forge API at `ref`, without a clone. */
export function forgeFiles(
  forge: Pick<GitForge, 'readFile' | 'listFiles'>,
  repo: string,
  ref?: string,
): RepoFiles {
  const listFiles = forge.listFiles?.bind(forge)
  return {
    read: (file) => forge.readFile(repo, file, ref),
    ...(listFiles
      ? {
          async list(dir: string) {
            const entries = await listFiles(repo, {
              ...(dir === '.' || dir === '' ? {} : { path: dir }),
              ...(ref ? { ref } : {}),
              recursive: true,
            })
            return entries.filter((entry) => entry.type === 'file').map((entry) => entry.path)
          },
        }
      : {}),
  }
}

/** Files of a local checkout; listing skips `node_modules` and `.git`. */
export function diskFiles(dir: string): RepoFiles {
  return {
    async read(file) {
      const handle = Bun.file(join(dir, file))
      return (await handle.exists()) ? handle.text() : undefined
    },
    async list(sub) {
      const base = join(dir, sub === '.' ? '' : sub)
      const paths: string[] = []
      for await (const path of new Bun.Glob('**/*').scan({
        cwd: base,
        dot: false,
        onlyFiles: true,
      })) {
        if (/(^|\/)(node_modules|\.git)\//.test(path)) continue
        paths.push(relative(dir, join(base, path)))
      }
      return paths
    },
  }
}

const joinPath = (dir: string, file: string) =>
  dir === '.' || dir === '' ? file : `${dir}/${file}`
const normalize = (dir: string) => dir.replace(/^\.\//, '').replace(/\/+$/, '') || '.'

async function workspaceManifests(
  files: RepoFiles,
  patterns: string[],
  file: string,
  limit: number,
  notes: string[],
): Promise<string[]> {
  const found = new Set<string>()
  for (const pattern of patterns.map(normalize)) {
    if (!/[*?]/.test(pattern)) {
      if (pattern !== '.') found.add(joinPath(pattern, file))
      continue
    }
    if (!files.list) {
      notes.push(`workspace pattern "${pattern}" cannot be expanded without file listing; skipped`)
      continue
    }
    const parts = pattern.split('/')
    const prefix = parts.slice(
      0,
      parts.findIndex((part) => /[*?]/.test(part)),
    )
    const regexp = globToRegExp(joinPath(pattern, file))
    for (const path of await files.list(prefix.join('/') || '.'))
      if (regexp.test(path) && !path.includes('node_modules/')) found.add(path)
  }
  const sorted = [...found].toSorted()
  if (sorted.length > limit)
    notes.push(`only the first ${limit} of ${sorted.length} workspace manifests were read`)
  return sorted.slice(0, limit)
}

/**
 * Reads the root `package.json`, its workspaces (`workspaces` or `pnpm-workspace.yaml`),
 * `pnpm-workspace.yaml` catalogs and overrides, and `go.mod` files (root and `go.work` modules).
 * Unreadable manifests are skipped with a note; it never throws for repository content.
 */
export function createPlanner(options: { maxWorkspaces?: number } = {}): Planner {
  const limit = options.maxWorkspaces ?? 50
  return {
    async plan(files, targets) {
      const usages: Usage[] = []
      const notes: string[] = []
      const npm = targets.filter((target) => target.ecosystem === 'npm')
      const go = targets.filter((target) => target.ecosystem === 'Go')
      const read = async (file: string, parse: (text: string) => Usage[]) => {
        try {
          const text = await files.read(file)
          if (text === undefined) return undefined
          usages.push(...parse(text))
          return text
        } catch (error) {
          notes.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
          return undefined
        }
      }

      if (npm.length) {
        const root = await read('package.json', (text) =>
          packageJsonUsages('package.json', text, npm),
        )
        const pnpm = await read('pnpm-workspace.yaml', (text) =>
          pnpmWorkspaceUsages('pnpm-workspace.yaml', text, npm),
        )
        const patterns = [
          ...(root ? safe(() => packageJsonWorkspaces(root)) : []),
          ...(pnpm ? safe(() => pnpmWorkspacePatterns(pnpm)) : []),
        ]
        for (const manifest of await workspaceManifests(
          files,
          patterns,
          'package.json',
          limit,
          notes,
        ))
          await read(manifest, (text) => packageJsonUsages(manifest, text, npm))
      }
      if (go.length) {
        await read('go.mod', (text) => goModUsages('go.mod', text, go))
        const work = await files.read('go.work').catch(() => undefined)
        for (const dir of work ? goWorkDirs(work) : []) {
          if (dir === '.') continue
          const manifest = joinPath(dir, 'go.mod')
          await read(manifest, (text) => goModUsages(manifest, text, go))
        }
      }
      return { usages, notes }
    },
  }
}

function safe(read: () => string[]): string[] {
  try {
    return read()
  } catch {
    return []
  }
}

/** Planner with default limits. */
export const defaultPlanner = createPlanner()
