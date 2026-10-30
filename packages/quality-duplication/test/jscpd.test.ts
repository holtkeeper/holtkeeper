import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { localRunner } from '@holtkeeper/exec'

import { duplicationCheck } from '../src/index.ts'

const jscpd = join(import.meta.dir, '../node_modules/.bin/jscpd')

const total = (name: string) => `export function ${name}(items: { price: number; qty: number }[]) {
  let sum = 0
  for (const item of items) {
    if (item.qty > 0) {
      sum += item.price * item.qty
    } else {
      console.warn('skipping item with no quantity', item)
    }
  }
  const tax = sum * 0.2
  const shipping = sum > 100 ? 0 : 10
  return Math.round((sum + tax + shipping) * 100) / 100
}
`

test.skipIf(!(await Bun.file(jscpd).exists()))(
  'finds two copied functions with the real jscpd',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quality-duplication-'))
    try {
      await mkdir(join(dir, 'src'))
      await mkdir(join(dir, 'node_modules/dep'), { recursive: true })
      await Bun.write(join(dir, 'src/a.ts'), total('total'))
      await Bun.write(join(dir, 'src/b.ts'), total('grandTotal'))
      await Bun.write(join(dir, 'node_modules/dep/index.ts'), total('vendored'))

      const result = await duplicationCheck({ minTokens: 20 }).run({ dir, runner: localRunner })

      expect(result.version).toMatch(/^\d+\.\d+\.\d+/)
      expect(result.duplication).toMatchObject({ duplicatedLines: 13, totalLines: 26 })
      expect(result.issues).toHaveLength(1)
      expect(result.issues?.[0]).toMatchObject({ category: 'duplication', severity: 'info' })
      expect(result.issues?.[0]?.message).toContain('src/a.ts:1-13')
      expect(result.issues?.[0]?.message).toContain('src/b.ts:1-13')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)
