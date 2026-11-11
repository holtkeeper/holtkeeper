import { expect, test } from 'bun:test'

import { agentGroupStatus } from './tasks.ts'
import type { AgentTask } from './types.ts'

const of = (...statuses: AgentTask['status'][]) =>
  agentGroupStatus(statuses.map((status) => ({ status })))

test('tasks: group status follows its tasks', () => {
  expect(of('proposed', 'proposed')).toBe('proposed')
  expect(of('queued', 'running', 'mr-open')).toBe('running')
  expect(of('queued', 'mr-open')).toBe('queued')
  expect(of('mr-open', 'done', 'failed')).toBe('mr-open')
  expect(of('done', 'cancelled')).toBe('done')
  expect(of('done', 'failed')).toBe('failed')
  expect(of('cancelled', 'cancelled')).toBe('cancelled')
})
