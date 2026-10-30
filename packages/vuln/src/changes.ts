import { join } from 'node:path'

async function fingerprint(dir: string, files: readonly string[]) {
  return Promise.all(
    files.map(async (file) => {
      const handle = Bun.file(join(dir, file))
      return (await handle.exists()) ? Bun.hash(await handle.arrayBuffer()) : undefined
    }),
  )
}

/**
 * Runs `action` and reports which of `files` (relative to `dir`) it created, changed or deleted.
 * Fixers use it to report `changedFiles` without trusting what external tools say they did.
 */
export async function trackChanges(
  dir: string,
  files: readonly string[],
  action: () => Promise<void>,
): Promise<string[]> {
  const before = await fingerprint(dir, files)
  await action()
  const after = await fingerprint(dir, files)
  return files.filter((_, index) => before[index] !== after[index])
}
