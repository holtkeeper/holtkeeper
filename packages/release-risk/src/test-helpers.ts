import type { Finding } from '@holtkeeper/vuln'

import type { BundleView, ChangelogView, ChangelogViewCommit, RiskSource } from './inputs.ts'

export function commit(
  sha: string,
  subject: string,
  parsed: Partial<ChangelogViewCommit['parsed']> = {},
  author = 'Ann',
): ChangelogViewCommit {
  return {
    sha,
    parents: ['p'],
    author: { name: author },
    subject,
    stats: { files: 1, insertions: 10, deletions: 2 },
    parsed: { breaking: false, description: subject, merge: false, wip: false, ...parsed },
  }
}

export const changelog = (
  commits: ChangelogViewCommit[],
  extra: Partial<ChangelogView> = {},
): ChangelogView => ({
  to: { name: 'v1.1.0' },
  from: { name: 'v1.0.0' },
  commits,
  ...extra,
})

export const source = <T>(kind: string, id: string, data: T, ref?: string): RiskSource<T> => ({
  id,
  kind,
  createdAt: '2026-10-29T00:00:00.000Z',
  ...(ref ? { ref } : {}),
  data,
})

export const bundle = (
  gzip: number,
  packages: { name: string; gzip: number }[] = [],
): BundleView => ({
  assets: [
    { name: 'index.js', kind: 'js', gzip },
    { name: 'logo.png', kind: 'image', gzip: 99_999 },
  ],
  packages,
})

export const finding = (id: string, severity: Finding['severity']): Finding => ({
  id,
  aliases: [],
  summary: id,
  severity,
  url: `https://osv.dev/${id}`,
  package: { name: 'lib', version: '1.0.0', ecosystem: 'npm' },
  source: 'package-lock.json',
  fixedVersions: [],
})

export const audit = (findings: Finding[]) => ({
  scanner: 'test',
  findings,
  ignored: [],
  expired: [],
  fixes: [],
  resolved: [],
  changedFiles: [],
})
