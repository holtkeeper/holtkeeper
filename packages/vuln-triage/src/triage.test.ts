import { describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'

import { securityTriageTaskKind, triageAdvisory } from './triage.ts'

const input = {
  id: 'GHSA-aaaa-bbbb-cccc',
  aliases: ['CVE-2026-1000'],
  summary: 'Template injection in widget-render',
  package: 'widget-render',
  ecosystem: 'npm',
  severity: 'critical' as const,
  versions: ['1.2.0'],
  fixedIn: ['1.2.1'],
  repositories: 2,
  details: {
    details: 'Widget templates evaluate input.',
    cvss: ['CVSS:3.1/AV:N'],
    cwes: ['CWE-94'],
  },
}

const agentAnswering = (output: unknown, tasks: AgentTask[] = []): Agent => ({
  name: 'fake',
  run: async (task) => {
    tasks.push(task)
    return { text: '', turns: 1, output } as never
  },
})

describe('triageAdvisory', () => {
  test('asks once, without tools, and returns the verdict', async () => {
    const tasks: AgentTask[] = []
    const verdict = await triageAdvisory(
      agentAnswering(
        { urgent: true, category: 'code-execution', reason: '  Remote code execution.  ' },
        tasks,
      ),
      input,
      { language: 'German' },
    )
    expect(verdict).toEqual({
      urgent: true,
      category: 'code-execution',
      reason: 'Remote code execution.',
    })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      capabilities: [],
      tier: 'main',
      taskKind: securityTriageTaskKind,
    })
    expect(tasks[0]?.prompt).toContain('in German')
    expect(tasks[0]?.prompt).toContain('CWE-94')
    expect(tasks[0]?.prompt).toContain('Widget templates evaluate input.')
  })

  test('rejects without a structured answer', async () => {
    expect(triageAdvisory(agentAnswering(undefined), input)).rejects.toThrow('no structured answer')
  })
})
