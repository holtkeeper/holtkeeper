import { mkdir, rm } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

import { type ChangePlan, type FileAccess, type PlanOptions, planChanges } from './apply.ts'
import type { CodeChange } from './types.ts'

/** Resolves `file` inside `root`, refusing paths that escape it. */
function inside(root: string, file: string): string {
  const path = resolve(root, file)
  const rel = relative(root, path)
  if (rel.startsWith('..') || rel === '' || resolve(rel) === rel)
    throw new Error(`path escapes the checkout: ${file}`)
  return path
}

const BOM = '\uFEFF'

/** Reads files of a local checkout. A byte order mark is left out of the text, see `applyToDisk`. */
export const diskFiles = (root: string): FileAccess => ({
  async read(file) {
    const handle = Bun.file(inside(root, file))
    if (!(await handle.exists())) return undefined
    return new TextDecoder().decode(await handle.arrayBuffer())
  },
  async readBytes(file) {
    const handle = Bun.file(inside(root, file))
    if (!(await handle.exists())) return undefined
    return new Uint8Array(await handle.arrayBuffer())
  },
})

async function hasBom(path: string) {
  const handle = Bun.file(path)
  if (!(await handle.exists())) return false
  const head = new Uint8Array(await handle.slice(0, 3).arrayBuffer())
  return head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
}

/** Applies changes to a local checkout and returns what was applied and what conflicted. */
export async function applyToDisk(
  root: string,
  changes: readonly CodeChange[],
  options: PlanOptions = {},
): Promise<ChangePlan> {
  const plan = await planChanges(changes, diskFiles(root), options)
  for (const { file, content, bytes } of plan.files) {
    const path = inside(root, file)
    if (bytes) {
      await mkdir(dirname(path), { recursive: true })
      await Bun.write(path, bytes)
    } else if (content === undefined) await rm(path, { force: true })
    else {
      // Edits work on text without the byte order mark; files that had one keep it.
      const bom = (await hasBom(path)) ? BOM : ''
      await mkdir(dirname(path), { recursive: true })
      await Bun.write(path, bom + content)
    }
  }
  return plan
}
