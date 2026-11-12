import { expect, test } from 'bun:test'

import type { RenovateData } from './model.ts'
import { renovateMetrics } from './report.ts'

const update = (
  dependency: string,
  type: 'major' | 'minor',
  vulnerability = false,
  mergeRequest?: number,
) => ({
  dependency,
  manager: 'npm',
  file: 'package.json',
  type,
  vulnerability,
  pending: false,
  ...(mergeRequest ? { mergeRequest } : {}),
})

const mergeRequest = (id: number, state: 'open' | 'merged', pipeline?: 'failed' | 'success') => ({
  id,
  title: `Update widget-lib ${id}`,
  branch: `renovate/widget-lib-${id}`,
  state,
  draft: false,
  ...(pipeline ? { pipeline } : {}),
  types: ['minor' as const],
  updates: 1,
})

const data: RenovateData = {
  status: 'ok',
  mode: 'report',
  readOnly: true,
  renovateVersion: '40.0.0',
  startedAt: '2026-01-01T00:00:00.000Z',
  durationMs: 1000,
  dependencies: 20,
  outdated: 3,
  managers: [],
  updates: [
    update('widget-lib', 'major', false, 1),
    update('gadget-lib', 'minor', true, 2),
    update('shape-lib', 'major', true, 3),
  ],
  deprecated: [],
  mergeRequests: [
    mergeRequest(1, 'open', 'failed'),
    mergeRequest(2, 'open', 'success'),
    mergeRequest(3, 'merged'),
  ],
  problems: [],
  output: '',
}

test('metrics count outdated, major, minor, patch and security updates and merge requests', () => {
  expect(renovateMetrics(data)).toEqual({
    status: 'ok',
    dependencies: 20,
    outdated: 3,
    major: 2,
    security: 2,
    minor: 1,
    patch: 0,
    open: 2,
    broken: 1,
    pending: { 'npm:widget-lib': 'broken', 'npm:gadget-lib': 'open' },
  })
})
