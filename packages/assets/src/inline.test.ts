import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanInlineSvgs } from './inline.ts'

const heavy =
  'M12.000000 2.000000C6.4771525 2.000000 2.000000 6.4771525 2.000000 12.000000C2.000000 17.5228475 6.4771525 22.000000 12.000000 22.000000C17.5228475 22.000000 22.000000 17.5228475 22.000000 12.000000C22.000000 6.4771525 17.5228475 2.000000 12.000000 2.000000Z'

test('finds bloated inline SVGs in components and proposes one change per file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-inline-'))
  try {
    await mkdir(join(dir, 'src'), { recursive: true })
    const tsx = `export const Ring = () => (\n  <svg viewBox="0 0 24 24">\n    <path d="${heavy}" />\n  </svg>\n)\n`
    await writeFile(join(dir, 'src/Ring.tsx'), tsx)
    await writeFile(join(dir, 'src/plain.ts'), `const d = "${heavy}"\n`)
    await mkdir(join(dir, 'node_modules/x'), { recursive: true })
    await writeFile(join(dir, 'node_modules/x/Icon.tsx'), tsx)
    const result = await scanInlineSvgs({ dir })
    expect(result.inlineSvgs).toMatchObject([
      { file: 'src/Ring.tsx', line: 2, endLine: 4, kind: 'paths', paths: 1 },
    ])
    expect(result.findings.map((finding) => [finding.id, finding.line])).toEqual([
      ['inline-svg:src/Ring.tsx', 2],
    ])
    const [change] = result.changes
    expect(change).toMatchObject({ id: 'assets:inline-svg:src/Ring.tsx', confidence: 'review' })
    const edit = change?.edits[0]
    expect(edit?.kind === 'replace' && edit.range.start.line).toBe(2)
    expect(edit?.kind === 'replace' && edit.newText).not.toContain('.000000')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
