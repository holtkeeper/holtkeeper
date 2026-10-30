import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sqliteStore } from '@holtkeeper/store-sqlite'
import { runAudit } from '@holtkeeper/vuln'
import { goFixer } from '@holtkeeper/vuln-go'
import { jsFixer } from '@holtkeeper/vuln-js'
import { osvFixer, osvScanner } from '@holtkeeper/vuln-osv'

const fixtures = join(import.meta.dir, '../../fixtures')
const store = sqliteStore({ path: join(import.meta.dir, 'holtkeeper.db') })
const scanner = osvScanner()

/** Real audits of the fixtures, stored as runs of made-up repositories over the past days. */
const repos = [
  { path: 'games/app-x', layout: { web: 'npm', server: 'go' }, fix: false },
  { path: 'games/adventure', layout: { '.': 'npm' }, fix: true },
  { path: 'tools/deployer', layout: { '.': 'go' }, fix: false },
]

for (const [index, repo] of repos.entries()) {
  const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-seed-'))
  for (const [target, fixture] of Object.entries(repo.layout)) {
    await cp(join(fixtures, fixture), join(dir, target), { recursive: true })
  }
  for (const daysAgo of [6, 3, 0]) {
    const fix = repo.fix && daysAgo === 0
    const startedAt = new Date(Date.now() - daysAgo * 86_400_000 - index * 3_600_000)
    const report = await runAudit({
      dir,
      scanner,
      fixers: fix ? [osvFixer(), jsFixer(), goFixer()] : [],
      allowlist:
        repo.path === 'games/app-x'
          ? [
              {
                id: 'GHSA-35jh-r3h4-6jhm',
                reason: 'Template injection needs SSR; this game renders on the client',
                author: 'root',
                expires: '2027-01-31',
              },
              {
                id: 'GHSA-29mw-wpgm-hmr9',
                reason: 'Reviewed last quarter',
                author: 'root',
                expires: '2026-09-30',
              },
            ]
          : [],
    })
    await store.auditRuns.add({
      repo: { forge: 'work', path: repo.path },
      trigger: daysAgo === 0 ? 'manual' : 'schedule',
      actor: 'root',
      startedAt: startedAt.toISOString(),
      finishedAt: new Date(startedAt.getTime() + 42_000).toISOString(),
      report,
    })
    console.log(
      `${repo.path} -${daysAgo}d: ${report.findings.length} active, ${report.resolved.length} fixed`,
    )
  }
  await rm(dir, { recursive: true, force: true })
}
await store.close()
