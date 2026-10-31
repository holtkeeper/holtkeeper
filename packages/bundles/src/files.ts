import { readdir } from 'node:fs/promises'
import { join, posix, relative } from 'node:path'

/** All files under `dir`, relative, with `/` separators, sorted. Dot directories are included. */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .toSorted()
}

/**
 * Turns a URL found in HTML, a manifest or an import into a dist-relative file, or `undefined`
 * when it is external or not part of the build. Root-relative URLs may carry a deploy base
 * (`/app/assets/x.js`), so leading segments are dropped until a known file matches; the site
 * root may also be the referring file's folder (`frontend/page.html` loading `/scripts/x.js`).
 */
export function toDistPath(
  ref: string,
  fromDir: string,
  files: ReadonlySet<string>,
): string | undefined {
  const url = ref.trim().replace(/[?#].*$/, '')
  if (!url || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(url)) return undefined
  let decoded = url
  try {
    decoded = decodeURI(url)
  } catch {}
  if (decoded.startsWith('/')) {
    const parts = decoded.slice(1).split('/')
    for (let start = 0; start < parts.length; start++) {
      const candidate = parts.slice(start).join('/')
      if (files.has(candidate)) return candidate
      const local = fromDir ? `${fromDir}/${candidate}` : undefined
      if (local && files.has(local)) return local
    }
    return undefined
  }
  const candidate = posix.normalize(posix.join(fromDir, decoded))
  return files.has(candidate) ? candidate : undefined
}

/** Relative import specifiers in an ES module: `static` imports and re-exports, `dynamic` `import()`. */
export function scanImports(code: string): { static: string[]; dynamic: string[] } {
  const found = { static: new Set<string>(), dynamic: new Set<string>() }
  for (const match of code.matchAll(
    /\b(?:import|export)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?(["'])(\.{0,2}\/[^"'\s]+)\1/g,
  )) {
    if (match[2]) found.static.add(match[2])
  }
  for (const match of code.matchAll(/\bimport\s*\(\s*(["'`])(\.{0,2}\/[^"'`\s]+)\1\s*\)/g)) {
    if (match[2]) found.dynamic.add(match[2])
  }
  return { static: [...found.static], dynamic: [...found.dynamic] }
}

/** `admin/index.html` → `admin`, `index.html` → `index`, `src/main.tsx` → `src/main`. */
export function entryNameOf(path: string): string {
  const stem = path.replace(/\.[^./]+$/, '')
  return stem.endsWith('/index') ? stem.slice(0, -'/index'.length) : stem
}
