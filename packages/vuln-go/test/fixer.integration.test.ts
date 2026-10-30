import { afterEach, expect, test } from 'bun:test'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Finding } from '@holtkeeper/vuln'

import { goFixer } from '../src/index.ts'

const fixture = join(import.meta.dir, '../../../fixtures/go')
let dir: string | undefined

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

const finding: Finding = {
  id: 'GO-2022-1059',
  aliases: ['CVE-2022-32149', 'GHSA-69ch-w2m2-3vjp'],
  summary: 'Denial of service via crafted Accept-Language header in golang.org/x/text/language',
  severity: 'high',
  url: 'https://pkg.go.dev/vuln/GO-2022-1059',
  package: { name: 'golang.org/x/text', version: '0.3.0', ecosystem: 'Go' },
  source: 'go.mod',
  fixedVersions: ['0.3.8'],
}

test.skipIf(!Bun.which('go'))(
  'upgrades golang.org/x/text in a copy of the fixture',
  async () => {
    dir = await mkdtemp(join(tmpdir(), 'holtkeeper-vuln-go-'))
    await cp(fixture, dir, { recursive: true })

    const result = await goFixer().fix({ dir, source: 'go.mod', findings: [finding] })

    expect(result.fixed).toEqual(['GO-2022-1059'])
    expect(result.changedFiles).toEqual(['go.mod', 'go.sum'])
    expect(await Bun.file(join(dir, 'go.mod')).text()).toContain('golang.org/x/text v0.3.8')
  },
  60_000,
)
