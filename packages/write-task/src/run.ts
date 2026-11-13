import { type Agent, BudgetExceededError } from '@holtkeeper/agent'
import type { AnalyzerContext } from '@holtkeeper/analyzer'
import { type CommitConventions, renderCommitConventions } from '@holtkeeper/commit-conventions'
import { runChecked } from '@holtkeeper/exec'
import type { GitForge, RepoRef } from '@holtkeeper/forge'

import { chooseCommitMessage, describeChange, publishChange } from './publish.ts'
import {
  type AgentReport,
  type CheckResult,
  WRITE_TASK_KIND,
  type WriteTaskData,
  type WriteTaskOptions,
  agentReportSchema,
} from './schema.ts'
import { type MergeRequestRequest, type WriteTaskLinks, reposToolset } from './tools.ts'
import {
  type CheckSpec,
  agentCommands,
  applyPatch,
  changedFiles,
  checksEnv,
  detectChecks,
  fixCommands,
  formatGoFiles,
  runChecks,
  taskBranch,
} from './workspace.ts'

/** A write task that must not run; it is never retried. */
export class WriteTaskRefusedError extends Error {
  override name = 'WriteTaskRefusedError'
}

/** What the instance allows for the task's repository, read when the task starts. */
export interface WriteTaskPolicy {
  /** The instance-wide switch (`tasks.write`); off until an admin turns it on. */
  enabled: boolean
  /** `repo.freeze` freezes the repository: its most specific entry in force is not a lift. */
  readOnly: boolean
  /** Do everything but push and open the merge request. */
  dryRun?: boolean
  /** Commands would run on the worker host without a sandbox (`execution.mode` `host`): refused. */
  unsandboxed?: boolean
  /** This week's write task spend reached the weekly cap: the task stops as a budget stop. */
  weeklyCapReached?: boolean
  /**
   * The repository has no tests by design (`repo.tests`): detected checks leave out tests and the
   * agent is told not to add any.
   */
  noTests?: { reason?: string }
}

type Checkout = NonNullable<AnalyzerContext<unknown>['checkout']>

/** Input of `runWriteTask`. */
export interface RunWriteTaskInput {
  repo: RepoRef
  options: WriteTaskOptions
  policy: WriteTaskPolicy
  forge: GitForge
  checkout: Checkout
  /** Needed unless the patch alone passes the checks. */
  agent?: Agent
  /** The repository's commit conventions; the commit message is checked against them. */
  conventions?: CommitConventions
  /** Variables for checks and the agent's commands (the egress proxy); never secrets. */
  env?: Record<string, string>
  /** What the agent's `repos` tools ask the server: related repositories, adding one to the task. */
  links?: WriteTaskLinks
  signal?: AbortSignal
  log?: (line: string) => void
  step?: <T>(name: string, run: () => Promise<T>) => Promise<T>
}

const KIND_INSTRUCTIONS: Record<WriteTaskOptions['kind'], string> = {
  change: 'Make the change the task describes.',
  fix: 'Fix the problem the task describes, with the smallest change that does it.',
  port: 'Bring the change the given patch makes to this repository, adapted to its code.',
  tests:
    'Write or update tests for what the task describes; change production code only when a test shows a bug.',
}

const SYSTEM = [
  'You change code in a repository checkout for a merge request that people review.',
  'Work only inside the current directory. You have no network access except through the',
  "repository's own check commands.",
  'Make minimal, idiomatic changes that follow the conventions already used in the repository.',
  'Never disable, skip or delete checks or tests to make them pass, never add lint-suppression',
  'or type-assertion escapes the code base does not already use for the same case, and never',
  'commit, push or create branches: Holtkeeper does that after you finish.',
].join(' ')

const trim = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n[truncated]` : text

/** The agent's prompt for the task, the failing checks and the conventions. */
function taskPrompt(input: {
  options: WriteTaskOptions
  checks: readonly CheckSpec[]
  failing: readonly CheckResult[]
  patch?: 'applied' | 'conflict'
  conventions?: CommitConventions
  noTests?: { reason?: string }
}): string {
  const { options } = input
  const parts = [KIND_INSTRUCTIONS[options.kind], `Task: ${options.title}`]
  if (options.prompt?.trim()) parts.push(options.prompt.trim())
  if (input.noTests)
    parts.push(
      `This repository has no tests by design${input.noTests.reason ? ` (${input.noTests.reason})` : ''}: do not add tests or test tooling.`,
    )
  if (options.patch && input.patch === 'conflict')
    parts.push(
      '`git apply -3` could not apply this patch here. Make the same change by hand:',
      `\`\`\`diff\n${trim(options.patch, 30_000)}\n\`\`\``,
    )
  if (input.patch === 'applied')
    parts.push('The given patch is already applied; only make the checks below pass.')
  for (const check of input.failing)
    parts.push(
      `Failing check ${check.name} (\`${check.command}\`, exit ${check.exitCode}):\n\`\`\`\n${trim(check.output, 6000)}\n\`\`\``,
    )
  if (input.checks.length)
    parts.push(
      `You may run only these commands: ${[...input.checks.map((check) => check.command), ...fixCommands(input.checks)].map((command) => `\`${command}\``).join(', ')}, and \`git status\`, \`git diff\`, \`git log\`.`,
    )
  if (input.conventions)
    parts.push(
      `Commit conventions of this repository:\n${trim(renderCommitConventions(input.conventions), 4000)}`,
    )
  parts.push(
    'When done, answer with `summary` (one paragraph for the merge request), `changes` (one entry per file or logical change), `remainingProblems` (empty when you believe every check passes) and `commitMessage` (one commit title that follows the conventions).',
  )
  return parts.join('\n\n')
}

/**
 * Runs one write task in a fresh writable checkout of `targetBranch`: refuses when write tasks
 * are off, the repository is read-only or commands would run unsandboxed, stops as a budget stop
 * once the weekly cap is reached, creates the branch `holtkeeper/<task-id>-<slug>`, tries
 * the task's patch with `git apply -3` and runs the checks, calls the agent (read, search, edit
 * and only the check commands; capped at `budgetUsd` and `maxTurns`) when there is no patch, it
 * does not apply or checks fail, runs the checks again, then commits with a message that follows
 * the repository's conventions and opens a merge request through the forge (a draft by default
 * and whenever checks fail). The whole task is aborted after `timeoutMinutes`. A budget stop of
 * the agent is rethrown and nothing is published.
 */
export async function runWriteTask(input: RunWriteTaskInput): Promise<WriteTaskData> {
  const { options, policy, forge, repo } = input
  const log = input.log ?? (() => {})
  const step = input.step ?? (<T>(_name: string, run: () => Promise<T>) => run())
  if (!policy.enabled) throw new WriteTaskRefusedError('write tasks are turned off (Ops › Tasks)')
  if (policy.readOnly)
    throw new WriteTaskRefusedError(`${repo.forge}:${repo.path} is read-only for Holtkeeper`)
  if (policy.unsandboxed)
    throw new WriteTaskRefusedError(
      'write tasks run repository scripts and need jobs.execution.mode mise or container',
    )
  if (policy.weeklyCapReached)
    throw new BudgetExceededError('write tasks reached their weekly spend cap (tasks.write)')
  if (!options.patch && !options.prompt?.trim())
    throw new WriteTaskRefusedError('a write task needs a prompt or a patch')

  const timeout = AbortSignal.timeout(options.timeoutMinutes * 60_000)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  const targetBranch = options.targetBranch ?? (await forge.getRepository(repo.path)).defaultBranch
  const branch = taskBranch(options.taskId, options.title)
  const workspace = await step('checkout', () =>
    input.checkout(repo, { ref: targetBranch, writable: true }),
  )
  try {
    const { dir, runner } = workspace
    if (!runner) throw new Error('the checkout has no command runner')
    await runChecked(runner, ['git', 'switch', '--quiet', '-C', branch], { cwd: dir, signal })
    const specs = await detectChecks(dir, options.checks, { tests: !policy.noTests, log })
    const check = () =>
      step('checks', async () => {
        await formatGoFiles(dir, runner, specs, { signal, log })
        return runChecks(dir, runner, specs, { signal, log, ...(input.env && { env: input.env }) })
      })
    const agentEnv = { ...input.env, ...checksEnv(specs) }

    let patch: 'applied' | 'conflict' | undefined
    let checks: CheckResult[] = []
    if (options.patch) {
      const applied = await step('apply patch', () => applyPatch(dir, runner, options.patch!, log))
      patch = applied ? 'applied' : 'conflict'
      if (applied) checks = await check()
    }

    let report: AgentReport | undefined
    let agentRun: WriteTaskData['agent']
    const asked: { mergeRequest?: MergeRequestRequest } = {}
    const needsAgent = patch !== 'applied' || checks.some((result) => !result.ok)
    if (needsAgent) {
      if (!input.agent)
        throw new Error(
          patch === 'applied'
            ? 'checks fail after the patch and no agent is configured'
            : 'this task needs an agent, but none is configured',
        )
      const agent = input.agent
      const result = await step('agent', () =>
        agent.run<AgentReport>({
          dir,
          system: SYSTEM,
          prompt: taskPrompt({
            options,
            checks: specs,
            failing: checks.filter((each) => !each.ok),
            ...(patch && { patch }),
            ...(input.conventions && { conventions: input.conventions }),
            ...(policy.noTests && { noTests: policy.noTests }),
          }),
          capabilities: ['read', 'search', 'edit', 'run'],
          commands: agentCommands(specs),
          toolsets: [
            reposToolset({
              repo,
              options,
              checks: specs,
              runChecks: (wanted) =>
                runChecks(dir, runner, wanted, {
                  signal,
                  log,
                  ...(input.env && { env: input.env }),
                }),
              ...(input.links && { links: input.links }),
              branch,
              targetBranch,
              onMergeRequest: (request) => {
                asked.mergeRequest = request
              },
            }),
          ],
          ...(Object.keys(agentEnv).length && { env: agentEnv }),
          output: agentReportSchema,
          tier: 'main',
          taskKind: WRITE_TASK_KIND,
          maxTurns: options.maxTurns,
          maxCostUsd: options.budgetUsd,
          signal,
        }),
      )
      report = result.output ?? {
        summary: result.text.trim().slice(0, 2000),
        changes: [],
        remainingProblems: ['the agent did not return a structured report'],
      }
      agentRun = {
        summary: report.summary,
        changes: report.changes,
        remainingProblems: report.remainingProblems,
        turns: result.turns,
        ...(result.costUsd !== undefined && { costUsd: result.costUsd }),
        ...(result.transcriptRef !== undefined && { transcriptRef: result.transcriptRef }),
      }
      checks = await check()
    }

    const path = patch === 'applied' ? (report ? 'patch+agent' : 'patch') : 'agent'
    const files = await changedFiles(dir, runner)
    const base = {
      taskId: options.taskId,
      title: options.title,
      kind: options.kind,
      branch,
      targetBranch,
      path,
      ...(patch && { patch }),
      files: files.map((file) => file.path),
      checks,
      ...(agentRun && { agent: agentRun }),
      ...(options.group && { group: options.group }),
    } satisfies Partial<WriteTaskData>
    if (files.length === 0) {
      log('nothing changed; no merge request')
      return { ...base, status: 'no-changes' }
    }

    const choice = chooseCommitMessage(
      [
        options.commitMessage,
        asked.mergeRequest?.title,
        report?.commitMessage,
        options.title,
      ].filter((message): message is string => Boolean(message)),
      input.conventions,
      options.kind,
    )
    for (const problem of choice.problems) log(`commit message: ${problem.message}`)
    const failed = checks.some((result) => !result.ok)
    if (policy.dryRun) {
      log(`dry run: would push ${files.length} files to ${branch}`)
      return { ...base, status: 'dry-run', commit: { message: choice.message } }
    }
    const title = choice.message.split('\n')[0]!
    const mergeRequest = await step('publish', () =>
      publishChange({
        forge,
        repo: repo.path,
        dir,
        files,
        branch,
        targetBranch,
        message: choice.message,
        title,
        description: describeChange({
          title: options.title,
          ...(options.prompt && { prompt: options.prompt }),
          taskId: options.taskId,
          path,
          checks,
          ...(report && { agent: report }),
          ...(asked.mergeRequest?.description && { notes: asked.mergeRequest.description }),
          problems: choice.problems,
        }),
        draft: options.draft || failed || asked.mergeRequest?.draft === true,
        ...(workspace.publisher && { git: workspace.publisher }),
      }),
    )
    log(`merge request ${mergeRequest.url}${mergeRequest.draft ? ' (draft)' : ''}`)
    return {
      ...base,
      status: 'opened',
      commit: {
        message: choice.message,
        ...(mergeRequest.sha !== undefined && { sha: mergeRequest.sha }),
      },
      mergeRequest: { id: mergeRequest.id, url: mergeRequest.url, draft: mergeRequest.draft },
    }
  } finally {
    await workspace.cleanup()
  }
}
