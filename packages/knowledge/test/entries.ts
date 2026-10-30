import type { KnowledgeEntry } from '@holtkeeper/store'

export const repo = (path: string, groups: string[] = [], forge = 'work') => ({
  forge,
  path,
  groups,
})

let counter = 0

export const entry = (overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  id: `k${++counter}`,
  title: 'Prefer Vitest',
  body: 'Use Vitest for unit tests.',
  kind: 'convention',
  scope: { all: true },
  topics: ['testing'],
  appliesTo: ['*'],
  status: 'accepted',
  source: 'human',
  author: 'jane',
  evidence: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  version: 1,
  ...overrides,
})
