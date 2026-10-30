import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { trackChanges } from './changes.ts'

describe('trackChanges', () => {
  test('reports created, changed and deleted files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-'))
    try {
      await writeFile(join(dir, 'same'), 'a')
      await writeFile(join(dir, 'changed'), 'a')
      await writeFile(join(dir, 'deleted'), 'a')
      const changed = await trackChanges(
        dir,
        ['same', 'changed', 'deleted', 'created'],
        async () => {
          await writeFile(join(dir, 'same'), 'a')
          await writeFile(join(dir, 'changed'), 'b')
          await rm(join(dir, 'deleted'))
          await writeFile(join(dir, 'created'), 'a')
        },
      )
      expect(changed).toEqual(['changed', 'deleted', 'created'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
