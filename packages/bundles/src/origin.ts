import { APP } from './data.ts'

/** Where one original source of a bundle comes from. */
export interface SourceOrigin {
  /** npm package name, `(app)`, or a bundler runtime such as `vite`, `webpack` or `(virtual)`. */
  package: string
  /** Version when the install path carries it, e.g. pnpm's `.pnpm/name@1.2.3/...`. */
  version?: string
  /** Install directory of the package, e.g. `node_modules/@scope/name`; only for packages. */
  installPath?: string
  /** File inside the package, or the app path, with `/` separators. */
  path: string
}

function versionFromStore(segment: string, name: string): string | undefined {
  const flat = name.replace('/', '+')
  if (!segment.startsWith(`${flat}@`)) return undefined
  const version = segment.slice(flat.length + 1).replace(/[_(].*$/, '')
  return version || undefined
}

/**
 * Maps a source path from a source map to the package that owns it. Understands nested and
 * scoped `node_modules`, pnpm and bun stores (`node_modules/.pnpm/name@1.0.0/node_modules/name`),
 * `webpack://` URLs, and virtual ids of Vite, Rollup and webpack runtimes. Anything else is app
 * code. Paths should already be relative to the project root; see `analyzeBundle`.
 */
export function sourceOrigin(source: string): SourceOrigin {
  let path = source.replaceAll('\\', '/').replace(/[?#].*$/, '')

  if (path.startsWith('\0')) {
    const id = path.slice(1)
    if (id.startsWith('vite/')) return { package: 'vite', path: id }
    return { package: '(virtual)', path: id }
  }
  if (/^(?:\/@vite\/|vite\/(?:preload-helper|modulepreload-polyfill))/.test(path)) {
    return { package: 'vite', path: path.replace(/^\/@/, '') }
  }
  if (path.startsWith('webpack/') || path.startsWith('(webpack)'))
    return { package: 'webpack', path }

  const webpack = /^webpack:\/\/[^/]*\/(.*)$/.exec(path)
  if (webpack) {
    const inner = webpack[1] ?? ''
    if (inner.startsWith('webpack/') || inner.startsWith('(webpack)'))
      return { package: 'webpack', path: inner }
    path = inner
  }
  path = path.replace(/^file:\/\//, '').replace(/^(?:\.\/)+/, '')

  const marker = path.lastIndexOf('node_modules/')
  if (marker !== -1) {
    const after = path.slice(marker + 'node_modules/'.length).split('/')
    const scoped = after[0]?.startsWith('@')
    const name = scoped ? `${after[0]}/${after[1] ?? ''}` : (after[0] ?? '')
    if (name && !name.startsWith('.')) {
      const nameParts = scoped ? 2 : 1
      const installPath = path.slice(0, marker) + `node_modules/${name}`
      const store = /node_modules\/\.(?:pnpm|bun)\/([^/]+)\/$/.exec(path.slice(0, marker))
      const version = store?.[1] ? versionFromStore(store[1], name) : undefined
      return {
        package: name,
        ...(version ? { version } : {}),
        installPath,
        path: after.slice(nameParts).join('/'),
      }
    }
  }
  return { package: APP, path }
}
