import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Whether any of `names` exists (file or directory) directly in `dir`. */
export async function hasAny(dir: string, names: readonly string[]): Promise<boolean> {
  const found = await Promise.all(
    names.map((name) =>
      stat(join(dir, name)).then(
        () => true,
        () => false,
      ),
    ),
  )
  return found.includes(true)
}

/** Whether `dir/package.json` lists `name` in any dependency field. */
export async function hasDependency(dir: string, name: string): Promise<boolean> {
  const manifest: unknown = await Bun.file(join(dir, 'package.json'))
    .json()
    .catch(() => undefined)
  if (typeof manifest !== 'object' || manifest === null) return false
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some(
    (field) => {
      const deps: unknown = Reflect.get(manifest, field)
      return typeof deps === 'object' && deps !== null && name in deps
    },
  )
}

/** Whether `dir/<file>` contains `text`. */
export async function fileContains(dir: string, file: string, text: string): Promise<boolean> {
  const content = await Bun.file(join(dir, file))
    .text()
    .catch(() => '')
  return content.includes(text)
}

/**
 * The project's own copy of a binary (`node_modules/.bin`, `.venv/bin`) when it has one, else the
 * bare name for `PATH` lookup — projects pin linter versions, so their copy wins.
 */
export function projectBinary(dir: string, name: string, folders = ['node_modules/.bin']): string {
  for (const folder of folders) {
    const path = join(dir, folder, name)
    if (existsSync(path)) return path
  }
  return name
}
