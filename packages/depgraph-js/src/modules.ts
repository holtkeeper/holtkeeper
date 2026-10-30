import { join, posix } from 'node:path'

import { GraphBuilder } from '@holtkeeper/depgraph'
import type { GraphSource } from '@holtkeeper/depgraph'

import { readJsWorkspaces, workspaceNode } from './workspaces.ts'
import type { JsWorkspace } from './workspaces.ts'

/** File extensions scanned and tried when an import omits one, in resolution order. */
export const sourceExtensions = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
] as const

const ignoredDirectories = new Set(['node_modules', 'dist', 'build', 'coverage'])

/** TypeScript projects import `./x.js` for `./x.ts`; these are the sources such an import may mean. */
const emittedFrom: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
}

/**
 * The scanned file a relative import refers to: the exact file, the TypeScript source of a `.js`
 * path, the path with each extension, or its `index` file. `undefined` for anything else.
 */
export function resolveImport(
  files: ReadonlySet<string>,
  importer: string,
  specifier: string,
): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier))
  const extension = posix.extname(base)
  const stem = base.slice(0, base.length - extension.length)
  const candidates = [
    base,
    ...(emittedFrom[extension] ?? []).map((ext) => stem + ext),
    ...sourceExtensions.map((ext) => base + ext),
    ...sourceExtensions.map((ext) => `${base}/index${ext}`),
  ]
  return candidates.find((candidate) => files.has(candidate))
}

async function scanFiles(dir: string, workspace: JsWorkspace): Promise<string[]> {
  const root = workspace.path === '.' ? 'src' : `${workspace.path}/src`
  const glob = new Bun.Glob(
    `${root}/**/*.{${sourceExtensions.map((ext) => ext.slice(1)).join(',')}}`,
  )
  const files: string[] = []
  try {
    for await (const file of glob.scan({ cwd: dir, onlyFiles: true })) {
      const path = file.replaceAll('\\', '/')
      if (path.split('/').some((part) => ignoredDirectories.has(part))) continue
      files.push(path)
    }
  } catch {
    return []
  }
  return files.toSorted()
}

const transpilers = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
}

/**
 * Imports between source files under each workspace's `src/` (`node_modules`, `dist`, `build`
 * and `coverage` are skipped). Type-only imports do not count. Relative imports become edges
 * between files; imports of a workspace package by name become edges to that workspace's node.
 * Files that fail to parse are left without edges.
 */
export function jsModuleSource(): GraphSource {
  return {
    name: 'js-modules',
    detect: (dir) => Bun.file(join(dir, 'package.json')).exists(),
    async load(dir) {
      const { root, packages } = await readJsWorkspaces(dir)
      const workspaces = [root, ...packages]
      const owners = new Map<string, JsWorkspace>()
      for (const workspace of workspaces)
        for (const file of await scanFiles(dir, workspace)) owners.set(file, workspace)
      if (owners.size === 0) return []

      const files = new Set(owners.keys())
      const byName = [...packages].toSorted((a, b) => b.name.length - a.name.length)
      const builder = new GraphBuilder()
      for (const [file, workspace] of owners)
        builder.node({
          id: file,
          name: file,
          ecosystem: 'npm',
          kind: 'module',
          path: file,
          workspace: workspace.name,
        })

      const codes = await Promise.all(
        [...owners].map(async ([file, owner]) => ({
          file,
          owner,
          code: await Bun.file(join(dir, file)).text(),
        })),
      )
      for (const { file, owner, code } of codes) {
        const transpiler = /\.[mc]?ts$/.test(file) ? transpilers.ts : transpilers.tsx
        let imports: { path: string }[]
        try {
          imports = transpiler.scanImports(code)
        } catch {
          continue
        }
        for (const { path: specifier } of imports) {
          if (specifier.startsWith('.')) {
            const target = resolveImport(files, file, specifier)
            if (target !== undefined && target !== file) builder.edge(file, target, 'import')
            continue
          }
          const workspace = byName.find(
            (pkg) => specifier === pkg.name || specifier.startsWith(`${pkg.name}/`),
          )
          if (workspace && workspace !== owner)
            builder.edge(file, builder.node(workspaceNode(workspace)), 'import')
        }
      }
      return [{ id: 'modules', source: 'imports', graph: builder.build() }]
    },
  }
}
