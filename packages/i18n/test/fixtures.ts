import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { CodeChange } from '@holtkeeper/changes'
import { planChanges } from '@holtkeeper/changes'

/** Writes `files` into a fresh temp directory and returns it with a cleanup function. */
export async function project(files: Record<string, string | object>) {
  const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-i18n-'))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await Bun.write(
      join(dir, path),
      typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
    )
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** Plans `changes` against files of `dir` and returns the new contents by path. */
export async function applied(dir: string, changes: readonly CodeChange[]) {
  const plan = await planChanges(changes, {
    async read(file) {
      const handle = Bun.file(join(dir, file))
      return (await handle.exists()) ? handle.text() : undefined
    },
  })
  return { plan, files: new Map(plan.files.map((f) => [f.file, f.content])) }
}
