import { describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'

import { withPhase } from './phase.ts'

describe('withPhase', () => {
  test('names the phase on tasks without one and keeps the phase a task names', async () => {
    const seen: AgentTask[] = []
    const agent: Agent = {
      name: 'fake',
      async run(task) {
        seen.push(task)
        return { text: '', turns: 0 }
      },
    }
    const phased = withPhase(withPhase(agent, 'update'), 'recheck')
    await withPhase(agent, 'initial').run({ dir: '/x', prompt: 'p' })
    await phased.run({ dir: '/x', prompt: 'p' })
    await phased.run({ dir: '/x', prompt: 'p', phase: 'reply' })
    expect(seen.map((task) => task.phase)).toEqual(['initial', 'recheck', 'reply'])
    expect(phased.name).toBe('fake')
  })
})
