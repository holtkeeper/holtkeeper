import { describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'
import type { AnalyzerContext } from '@holtkeeper/analyzer'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { GitForge } from '@holtkeeper/forge'

import { createUpgradeCheckAnalyzer, upgradeCheckAnalyzer } from './analyzer.ts'
import { UPGRADE_CHECK_TASK_KIND, type UpgradeCheckOptions, upgradeCheckRef } from './schema.ts'

const FROM = 'a'.repeat(40)
const TO = 'b'.repeat(40)

function gitRunner(options: { fromMissing?: boolean } = {}) {
  return createFakeRunner((command) => {
    const rest = command.slice(4)
    const [verb] = rest
    if (verb === 'rev-parse') {
      const ref = rest.at(-1) ?? ''
      if (ref.startsWith('v2.0.0')) return { stdout: `${TO}\n` }
      if (ref.startsWith('v1.0.0') && !options.fromMissing) return { stdout: `${FROM}\n` }
      return { exitCode: 1 }
    }
    if (verb === 'log') return { stdout: 'feat: add widgets\n' }
    if (rest.includes('--name-status')) return { stdout: 'M\0src/widget.ts\0' }
    if (rest.includes('--numstat')) return { stdout: '1\t1\tsrc/widget.ts\0' }
    if (verb === 'diff')
      return {
        stdout:
          'diff --git a/src/widget.ts b/src/widget.ts\n--- a/src/widget.ts\n+++ b/src/widget.ts\n@@ -1 +1 @@\n-a\n+b\n',
      }
    return undefined
  })
}

function agentOf() {
  const tasks: AgentTask[] = []
  const agent: Agent = {
    name: 'fake',
    async run<Output>(task: AgentTask<Output>) {
      tasks.push(task)
      const output =
        task.taskKind === UPGRADE_CHECK_TASK_KIND
          ? { summary: 'Fine.', findings: [] }
          : task.phase === 'verdict'
            ? { verdict: 'safe', summary: 'Safe to upgrade.' }
            : { areas: [] }
      return { text: '', output: output as Output, turns: 1 }
    },
  }
  return { agent, tasks }
}

const contextOf = (
  overrides: Partial<AnalyzerContext<UpgradeCheckOptions>>,
): AnalyzerContext<UpgradeCheckOptions> => ({
  repo: { forge: 'gitlab', path: 'shop/widgets' },
  dir: '/checkout',
  runner: gitRunner().runner,
  options: { from: 'v1.0.0', to: 'v2.0.0', fromLabel: '1.0.0' },
  ...overrides,
})

describe('upgradeCheckAnalyzer', () => {
  test('declares an on-demand repo analyzer that needs a checkout, forge and agent', () => {
    expect(upgradeCheckAnalyzer.kind).toBe('upgrade-check')
    expect(upgradeCheckAnalyzer.scope).toBe('repo')
    expect(upgradeCheckAnalyzer.needs).toEqual({ checkout: true, forge: true, agent: 'required' })
    expect(upgradeCheckAnalyzer.refresh).toBeUndefined()
    expect(upgradeCheckAnalyzer.options.safeParse({ from: FROM }).success).toBe(false)
  })

  test('reads the range with git and stores it under the range ref', async () => {
    const { agent, tasks } = agentOf()
    const inputs: unknown[] = []
    const analyzer = createUpgradeCheckAnalyzer({
      inputsFor: async (_repo, range) => {
        inputs.push(range.from.sha, range.to.sha)
        return { apiChanges: '- `@acme/widgets`: removed `makeWidget`' }
      },
      contextFor: async () => 'Write in English.',
    })
    const result = await analyzer.run(contextOf({ agent }))
    expect(result.ref).toBe(upgradeCheckRef(FROM, TO))
    expect(result.sha).toBe(TO)
    expect(result.data.from).toEqual({ ref: 'v1.0.0', sha: FROM, label: '1.0.0' })
    expect(result.data.to).toEqual({ ref: 'v2.0.0', sha: TO })
    expect(result.data.verdict).toBe('safe')
    expect(inputs).toEqual([FROM, TO])
    const area = tasks.find((task) => task.taskKind === UPGRADE_CHECK_TASK_KIND)
    expect(area?.prompt).toContain('removed `makeWidget`')
    expect(area?.prompt).toContain('feat: add widgets')
    expect(area?.context).toBe('Write in English.')
  })

  test('falls back to the forge when the from commit cannot be found', async () => {
    const { agent } = agentOf()
    const compared: string[] = []
    const forge = {
      compareCommits: async (_repo: string, from: string, to: string) => {
        compared.push(from, to)
        return [
          {
            oldPath: 'src/a.ts',
            newPath: 'src/a.ts',
            status: 'modified' as const,
            diff: '@@ -1 +1 @@\n-a\n+b\n',
          },
        ]
      },
    } as unknown as GitForge
    const result = await upgradeCheckAnalyzer.run(
      contextOf({ agent, forge, runner: gitRunner({ fromMissing: true }).runner }),
    )
    expect(compared).toEqual(['v1.0.0', TO])
    expect(result.data.from.sha).toBe('v1.0.0')
    expect(result.data.areas).toHaveLength(1)
  })

  test('fails without an agent or a checkout', async () => {
    const noAgent = await upgradeCheckAnalyzer.run(contextOf({})).catch((reason: unknown) => reason)
    expect(String(noAgent)).toContain('needs an agent')
    const { agent } = agentOf()
    const { dir: _dir, ...withoutDir } = contextOf({ agent })
    const noCheckout = await upgradeCheckAnalyzer.run(withoutDir).catch((reason: unknown) => reason)
    expect(String(noCheckout)).toContain('needs a checkout')
  })
})
