import { describe, expect, test } from 'bun:test'

import type { AuditRun } from '@holtkeeper/store'
import type { Finding } from '@holtkeeper/vuln'

import { sourceInfo } from './sources.ts'
import { summarizeRun } from './summary.ts'

const finding = (id: string, source: string, severity: Finding['severity']): Finding => ({
  id,
  aliases: [],
  summary: '',
  severity,
  url: '',
  package: { name: 'p', version: '1', ecosystem: 'npm' },
  source,
  fixedVersions: [],
})

describe('sourceInfo', () => {
  test('recognizes lockfiles in nested paths', () => {
    expect(sourceInfo('apps/web/pnpm-lock.yaml')).toEqual({
      tool: 'pnpm',
      label: 'pnpm',
      language: 'JavaScript',
    })
    expect(sourceInfo('go.mod').language).toBe('Go')
    expect(sourceInfo('weird.lock')).toEqual({
      tool: 'other',
      label: 'weird.lock',
      language: 'Other',
    })
  })
})

describe('summarizeRun', () => {
  test('counts severities and collects languages and tools', () => {
    const run: AuditRun = {
      id: 'r1',
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'cli',
      startedAt: 'a',
      finishedAt: 'b',
      report: {
        scanner: 'osv-scanner',
        findings: [
          finding('1', 'bun.lock', 'high'),
          finding('2', 'go.mod', 'critical'),
          finding('3', 'bun.lock', 'high'),
        ],
        ignored: [{ finding: finding('4', 'pom.xml', 'low'), entry: { id: '4', reason: 'r' } }],
        expired: [],
        fixes: [],
        resolved: [finding('5', 'package-lock.json', 'medium')],
        changedFiles: ['package-lock.json'],
      },
    }
    expect(summarizeRun(run)).toEqual({
      id: 'r1',
      repo: run.repo,
      trigger: 'cli',
      startedAt: 'a',
      finishedAt: 'b',
      severities: { critical: 1, high: 2, medium: 0, low: 0, unknown: 0 },
      active: 3,
      ignored: 1,
      resolved: 1,
      expiredAllowlist: 0,
      languages: ['Go', 'Java', 'JavaScript'],
      tools: ['Bun', 'Go modules', 'Maven', 'npm'],
      changedFiles: 1,
    })
  })
})
