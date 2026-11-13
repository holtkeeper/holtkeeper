import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Agent, type AgentTask, BudgetExceededError } from '@holtkeeper/agent'
import { commitConventions } from '@holtkeeper/commit-conventions'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { CommitInput, CreateMergeRequestInput, GitForge } from '@holtkeeper/forge'

import { type RunWriteTaskInput, WriteTaskRefusedError, runWriteTask } from './run.ts'
import { type AgentReport, writeTaskOptionsSchema } from './schema.ts'

const dirs: string[] = []
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

const repo = { forge: 'work', path: 'shapes/widgets' }

function fakeForge(files: Record<string, string> = {}) {
  const commits: CommitInput[] = []
  const opened: CreateMergeRequestInput[] = []
  const deleted: string[] = []
  const forge = {
    async deleteBranch(_repo: string, branch: string) {
      deleted.push(branch)
    },
    async getRepository(path: string) {
      return { path, defaultBranch: 'main', cloneUrl: `https://forge.test/${path}.git` }
    },
    async readFile(_repo: string, file: string) {
      return files[file]
    },
    async findMergeRequest() {
      return undefined
    },
    async commit(_repo: string, input: CommitInput) {
      commits.push(input)
      return { sha: 'c0ffee12', webUrl: 'https://forge.test/c0ffee12' }
    },
    async createMergeRequest(_repo: string, input: CreateMergeRequestInput) {
      opened.push(input)
      return {
        id: 7,
        title: input.title,
        description: input.description ?? '',
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        state: 'open' as const,
        draft: input.draft ?? false,
        labels: [],
        author: 'holtkeeper',
        webUrl: 'https://forge.test/shapes/widgets/-/merge_requests/7',
      }
    },
  } as unknown as GitForge
  return { forge, commits, opened, deleted }
}

interface Scenario {
  applies?: boolean
  /** Exit code of the test check per run, in order; then 0. */
  testExits?: number[]
  status?: string
}

async function workspace(scenario: Scenario = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'write-task-'))
  dirs.push(dir)
  await writeFile(join(dir, 'package.json'), '{"scripts":{"test":"bun test","lint":"oxlint"}}\n')
  await writeFile(join(dir, 'bun.lock'), '')
  await writeFile(join(dir, 'widget.ts'), 'export const size = 2\n')
  const testExits = [...(scenario.testExits ?? [])]
  const { runner, calls } = createFakeRunner(([binary, ...args]) => {
    if (binary === 'git' && args[0] === 'apply') return { exitCode: scenario.applies ? 0 : 1 }
    if (binary === 'git' && args[0] === 'status')
      return { stdout: scenario.status ?? ' M widget.ts\0' }
    if (binary === 'sh' && args[1] === 'bun run test') return { exitCode: testExits.shift() ?? 0 }
    return undefined
  })
  let cleaned = false
  const checkout: RunWriteTaskInput['checkout'] = async () => ({
    dir,
    sha: 'abc123',
    ref: 'main',
    runner,
    async cleanup() {
      cleaned = true
    },
  })
  return { dir, runner, calls, checkout, cleaned: () => cleaned }
}

function fakeAgent(report: Partial<AgentReport> | Error = {}) {
  const tasks: AgentTask[] = []
  const agent: Agent = {
    name: 'fake',
    async run<Output>(task: AgentTask<Output>) {
      tasks.push(task)
      if (report instanceof Error) throw report
      return {
        text: '',
        turns: 3,
        costUsd: 0.42,
        output: {
          summary: 'Doubled the widget size.',
          changes: ['widget.ts: size 4'],
          remainingProblems: [],
          ...report,
        } as Output,
      }
    },
  }
  return { agent, tasks }
}

const options = (extra: Record<string, unknown> = {}) =>
  writeTaskOptionsSchema.parse({ taskId: 'ab12cd', title: 'Double the widget size', ...extra })

const enabled = { enabled: true, readOnly: false }

describe('runWriteTask', () => {
  test('refuses while write tasks are off, on read-only repositories and without work', async () => {
    const { forge, commits } = fakeForge()
    const { checkout } = await workspace()
    const base = { repo, forge, checkout, options: options({ prompt: 'Make it 4.' }) }
    expect(
      runWriteTask({ ...base, policy: { enabled: false, readOnly: false } }),
    ).rejects.toBeInstanceOf(WriteTaskRefusedError)
    expect(runWriteTask({ ...base, policy: { enabled: true, readOnly: true } })).rejects.toThrow(
      'read-only',
    )
    expect(runWriteTask({ ...base, options: options(), policy: enabled })).rejects.toThrow(
      'prompt or a patch',
    )
    expect(runWriteTask({ ...base, policy: { ...enabled, unsandboxed: true } })).rejects.toThrow(
      'jobs.execution.mode',
    )
    expect(
      runWriteTask({ ...base, policy: { ...enabled, weeklyCapReached: true } }),
    ).rejects.toBeInstanceOf(BudgetExceededError)
    expect(commits).toEqual([])
  })

  test('the patch fast path opens a draft merge request without an agent', async () => {
    const { forge, commits, opened } = fakeForge()
    const space = await workspace({ applies: true })
    const { agent, tasks } = fakeAgent()
    const data = await runWriteTask({
      repo,
      forge,
      checkout: space.checkout,
      agent,
      policy: enabled,
      options: options({ patch: 'diff --git a/widget.ts b/widget.ts\n', kind: 'port' }),
    })

    expect(tasks).toEqual([])
    expect(data).toMatchObject({
      status: 'opened',
      path: 'patch',
      patch: 'applied',
      branch: 'holtkeeper/ab12cd-double-the-widget-size',
      files: ['widget.ts'],
      mergeRequest: { id: 7, draft: true },
    })
    expect(space.calls.map((call) => call.command.join(' '))).toContain(
      'git switch --quiet -C holtkeeper/ab12cd-double-the-widget-size',
    )
    expect(space.calls.some((call) => call.command.join(' ') === 'sh -c bun run test')).toBe(true)
    expect(commits[0]).toMatchObject({
      branch: 'holtkeeper/ab12cd-double-the-widget-size',
      startBranch: 'main',
      changes: [{ action: 'update', path: 'widget.ts', content: 'export const size = 2\n' }],
    })
    expect(opened[0]).toMatchObject({
      sourceBranch: 'holtkeeper/ab12cd-double-the-widget-size',
      targetBranch: 'main',
      draft: true,
    })
    expect(space.cleaned()).toBe(true)
  })

  test('falls back to the agent when the patch conflicts', async () => {
    const { forge } = fakeForge()
    const space = await workspace({ applies: false })
    const { agent, tasks } = fakeAgent()
    const data = await runWriteTask({
      repo,
      forge,
      checkout: space.checkout,
      agent,
      policy: enabled,
      options: options({ patch: 'diff --git a/widget.ts b/widget.ts\n', kind: 'port' }),
    })

    expect(data).toMatchObject({ path: 'agent', patch: 'conflict', status: 'opened' })
    expect(tasks[0]?.prompt).toContain('could not apply this patch')
    expect(space.calls.map((call) => call.command.join(' '))).toContain('git reset --hard --quiet')
  })

  test('calls the agent with the failing checks when the patch breaks them', async () => {
    const { forge } = fakeForge()
    const space = await workspace({ applies: true, testExits: [1] })
    const { agent, tasks } = fakeAgent()
    const data = await runWriteTask({
      repo,
      forge,
      checkout: space.checkout,
      agent,
      policy: enabled,
      options: options({ patch: 'diff --git a/widget.ts b/widget.ts\n' }),
    })

    expect(data.path).toBe('patch+agent')
    expect(data.checks.every((check) => check.ok)).toBe(true)
    expect(tasks[0]?.prompt).toContain('Failing check test')
  })

  test('caps the agent and keeps its commands to the checks', async () => {
    const { forge } = fakeForge()
    const space = await workspace()
    const { agent, tasks } = fakeAgent()
    await runWriteTask({
      repo,
      forge,
      checkout: space.checkout,
      agent,
      policy: enabled,
      env: { HTTPS_PROXY: 'http://proxy.test:8080' },
      options: options({ prompt: 'Make it 4.', budgetUsd: 1.5, maxTurns: 30 }),
    })

    const task = tasks[0]
    expect(task).toMatchObject({
      maxCostUsd: 1.5,
      maxTurns: 30,
      tier: 'main',
      taskKind: 'write-task',
      capabilities: ['read', 'search', 'edit', 'run'],
      env: { HTTPS_PROXY: 'http://proxy.test:8080' },
    })
    expect(task?.commands).toContain('bun run test')
    expect(task?.commands).toContain('mise exec -- bun run lint')
    expect(task?.commands).not.toContain('bun install --frozen-lockfile; curl')
  })

  test('a Go module formats the changed files before checks and gives the agent the Go env', async () => {
    const { forge } = fakeForge()
    const space = await workspace({ status: ' M widget.go\0' })
    await writeFile(join(space.dir, 'go.mod'), 'module example.com/acme/widgets\n\ngo 1.23\n')
    const { agent, tasks } = fakeAgent()
    const data = await runWriteTask({
      repo,
      forge,
      checkout: space.checkout,
      agent,
      policy: enabled,
      env: { HTTPS_PROXY: 'http://proxy.test:8080' },
      options: options({ prompt: 'Make it 4.' }),
    })
    expect(tasks[0]?.env).toEqual({
      HTTPS_PROXY: 'http://proxy.test:8080',
      GOTOOLCHAIN: 'local',
      GOFLAGS: '-mod=mod',
    })
    expect(tasks[0]?.commands).toEqual(
      expect.arrayContaining(['gofmt -l', 'gofmt -w', 'go vet ./...']),
    )
    expect(tasks[0]?.prompt).toContain('`gofmt -w`')
    const commands = space.calls.map((call) => call.command.join(' '))
    expect(commands.indexOf('gofmt -w widget.go')).toBeLessThan(
      commands.indexOf('gofmt -l widget.go'),
    )
    expect(data.checks.map((check) => check.command)).toContain('go test ./...')
  })

  test('a repository with no tests by design runs no test checks and tells the agent', async () => {
    const { forge } = fakeForge()
    const space = await workspace()
    const { agent, tasks } = fakeAgent()
    await runWriteTask({
      repo,
      forge,
      checkout: space.checkout,
      agent,
      policy: { ...enabled, noTests: { reason: 'Config only' } },
      options: options({ prompt: 'Make it 4.' }),
    })
    expect(tasks[0]?.prompt).toContain(
      'This repository has no tests by design (Config only): do not add tests or test tooling.',
    )
    expect(tasks[0]?.commands).toContain('bun run lint')
    expect(tasks[0]?.commands).not.toContain('bun run test')
  })

  test('a budget stop publishes nothing', async () => {
    const { forge, commits, opened } = fakeForge()
    const space = await workspace()
    const { agent } = fakeAgent(new BudgetExceededError('AI budget exceeded', { costUsd: 1.5 }))
    expect(
      runWriteTask({
        repo,
        forge,
        checkout: space.checkout,
        agent,
        policy: enabled,
        options: options({ prompt: 'Make it 4.' }),
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError)
    await Bun.sleep(0)
    expect(commits).toEqual([])
    expect(opened).toEqual([])
  })

  test('commits with a message that follows the conventions and marks failing checks', async () => {
    const { forge, commits, opened } = fakeForge()
    const conventions = await commitConventions({
      forge,
      repo: repo.path,
      setting: { commit: { conventional: true, types: ['feat', 'fix', 'chore'] }, history: false },
    })
    const space = await workspace({ testExits: [1] })
    const { agent } = fakeAgent({ commitMessage: 'Doubled widgets' })
    const data = await runWriteTask({
      repo,
      forge,
      checkout: space.checkout,
      agent,
      conventions,
      policy: enabled,
      options: options({ prompt: 'Make it 4.', draft: false }),
    })

    expect(commits[0]?.message).toBe('chore: doubled widgets')
    expect(opened[0]).toMatchObject({ title: 'chore: doubled widgets', draft: true })
    expect(opened[0]?.description).toContain('**failed** (1)')
    expect(data.commit?.message).toBe('chore: doubled widgets')
  })

  test('takes the agent message when it fits and opens a ready merge request when checks pass', async () => {
    const { forge, opened } = fakeForge()
    const conventions = await commitConventions({
      forge,
      repo: repo.path,
      setting: { commit: { conventional: true }, history: false },
    })
    const space = await workspace()
    const { agent } = fakeAgent({ commitMessage: 'fix(widgets): double the size' })
    await runWriteTask({
      repo,
      forge,
      checkout: space.checkout,
      agent,
      conventions,
      policy: enabled,
      options: options({ prompt: 'Make it 4.', draft: false }),
    })
    expect(opened[0]).toMatchObject({ title: 'fix(widgets): double the size', draft: false })
  })

  test('mounts the repos toolset: checks, related repositories and the merge request text', async () => {
    const { forge, opened } = fakeForge()
    const space = await workspace({ testExits: [1] })
    const answers: string[] = []
    const requested: string[] = []
    const agent: Agent = {
      name: 'fake',
      async run<Output>(task: AgentTask<Output>) {
        const tools = task.toolsets?.find((toolset) => toolset.name === 'repos')?.tools ?? []
        const call = async (name: string, input: Record<string, unknown>) =>
          answers.push(
            await tools
              .find((tool) => tool.name === name)!
              .run(input, { dir: task.dir, signal: new AbortController().signal }),
          )
        await call('run_checks', { names: ['test'] })
        await call('run_checks', { names: ['deploy'] })
        await call('list_related_repos', {})
        await call('request_repository', { repo: 'work:shapes/base', reason: 'shares the base' })
        await call('request_repository', { repo: 'work:shapes/widgets', reason: 'self' })
        await call('open_merge_request', {
          title: 'fix: double the widget size',
          description: 'Widgets look right on large screens now.',
          draft: true,
        })
        return {
          text: '',
          turns: 4,
          output: { summary: 'Doubled.', changes: [], remainingProblems: [] } as Output,
        }
      },
    }
    await runWriteTask({
      repo,
      forge,
      checkout: space.checkout,
      agent,
      policy: enabled,
      options: options({ prompt: 'Make it 4.', draft: false }),
      links: {
        related: async () => [{ repo: 'work:shapes/base', relation: 'same group shapes' }],
        requestRepository: async (input) => {
          requested.push(`${input.target}: ${input.reason}`)
          return 'Asked people.'
        },
      },
    })
    expect(answers[0]).toContain('test (`bun run test`): failed with exit 1')
    expect(answers[1]).toContain('No such check')
    expect(answers[2]).toBe('work:shapes/base (same group shapes)')
    expect(answers[3]).toBe('Asked people.')
    expect(answers[4]).toContain('the repository you are working on')
    expect(answers[5]).toContain('opens when you finish')
    expect(requested).toEqual(['work:shapes/base: shares the base'])
    expect(opened[0]).toMatchObject({ title: 'fix: double the widget size', draft: true })
    expect(opened[0]?.description).toContain('Widgets look right on large screens now.')
  })

  test('reports no changes and a dry run without touching the forge', async () => {
    const { forge, commits } = fakeForge()
    const unchanged = await workspace({ status: '' })
    const { agent } = fakeAgent()
    const none = await runWriteTask({
      repo,
      forge,
      checkout: unchanged.checkout,
      agent,
      policy: enabled,
      options: options({ prompt: 'Make it 4.' }),
    })
    expect(none.status).toBe('no-changes')

    const changed = await workspace()
    const dry = await runWriteTask({
      repo,
      forge,
      checkout: changed.checkout,
      agent,
      policy: { ...enabled, dryRun: true },
      options: options({ prompt: 'Make it 4.' }),
    })
    expect(dry.status).toBe('dry-run')
    expect(commits).toEqual([])
  })

  test('pushes over git when the checkout signs', async () => {
    const { forge, commits, opened } = fakeForge()
    const space = await workspace({ applies: true })
    const pushed: string[] = []
    const data = await runWriteTask({
      repo,
      forge,
      checkout: async (target, request) => ({
        ...(await space.checkout(target, request)),
        publisher: {
          async commit({ message }) {
            pushed.push(`commit ${message}`)
            return { sha: 'beef0001' }
          },
          async push({ branch }) {
            pushed.push(`push ${branch}`)
            return { pushed: true, sha: 'beef0001' }
          },
        },
      }),
      policy: enabled,
      options: options({ patch: 'diff --git a/widget.ts b/widget.ts\n' }),
    })
    expect(commits).toEqual([])
    expect(pushed).toEqual([
      'commit Double the widget size',
      'push holtkeeper/ab12cd-double-the-widget-size',
    ])
    expect(opened).toHaveLength(1)
    expect(data.commit?.sha).toBe('beef0001')
  })
})
