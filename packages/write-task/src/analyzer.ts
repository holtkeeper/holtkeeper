import { type AnyAnalyzer, defineAnalyzer } from '@holtkeeper/analyzer'
import type { CommitConventions } from '@holtkeeper/commit-conventions'
import type { RepoRef } from '@holtkeeper/forge'
import { type Metric, type Report, defineAnalysis } from '@holtkeeper/report'

import { type WriteTaskPolicy, runWriteTask } from './run.ts'
import {
  WRITE_POOL,
  WRITE_TASK_KIND,
  type WriteTaskData,
  type WriteTaskOptions,
  writeTaskDataSchema,
  writeTaskOptionsSchema,
} from './schema.ts'
import type { WriteTaskLinks } from './tools.ts'

function metricsOf(data: WriteTaskData): Metric[] {
  const failing = data.checks.filter((check) => !check.ok).length
  return [
    {
      id: 'status',
      label: 'Status',
      value:
        data.status === 'opened' ? (data.mergeRequest?.draft ? 'draft MR' : 'MR') : data.status,
      unit: 'text',
      tone: data.status === 'opened' ? 'good' : 'neutral',
    },
    { id: 'files', label: 'Files', value: data.files.length, unit: 'count' },
    {
      id: 'checks',
      label: 'Failing checks',
      value: failing,
      unit: 'count',
      tone: failing ? 'bad' : 'good',
    },
    ...(data.agent?.costUsd !== undefined
      ? [
          {
            id: 'cost',
            label: 'Cost',
            value: `$${data.agent.costUsd.toFixed(2)}`,
            unit: 'text' as const,
          },
        ]
      : []),
  ]
}

/** The `write-task` analysis: what one write task changed and the merge request it opened. */
export const writeTaskAnalysis = defineAnalysis<WriteTaskData>({
  kind: WRITE_TASK_KIND,
  label: 'Write task',
  schema: writeTaskDataSchema,
  summarize: metricsOf,
  toReport(current): Report {
    const data = current.data
    const lines = [
      `Branch \`${data.branch}\` from \`${data.targetBranch}\`, made by ${data.path}.`,
      ...(data.mergeRequest
        ? [`Merge request: [!${data.mergeRequest.id}](${data.mergeRequest.url})`]
        : []),
      ...(data.commit ? [`Commit: \`${data.commit.message.split('\n')[0]}\``] : []),
      ...(data.agent ? ['', data.agent.summary] : []),
    ]
    return {
      kind: WRITE_TASK_KIND,
      title: data.title,
      subject: { repo: current.repo },
      generatedAt: current.createdAt,
      metrics: metricsOf(data),
      sections: [
        { id: 'outcome', title: 'Outcome', blocks: [{ type: 'markdown', text: lines.join('\n') }] },
        {
          id: 'checks',
          title: 'Checks',
          blocks: [
            {
              type: 'table',
              columns: [
                { key: 'name', label: 'Check' },
                { key: 'command', label: 'Command', format: 'code' },
                { key: 'result', label: 'Result' },
              ],
              rows: data.checks.map((check) => ({
                name: check.name,
                command: check.command,
                result: {
                  text: check.ok ? 'passed' : `failed (${check.exitCode})`,
                  tone: check.ok ? 'good' : 'bad',
                },
              })),
            },
          ],
        },
      ],
    }
  },
})

/** What the write task analyzer reads from the server. */
export interface WriteTaskAnalyzerDeps {
  /** The instance's switch and the repository's read-only setting. Default: write tasks are off. */
  policy?: (repo: RepoRef) => Promise<WriteTaskPolicy>
  /** The repository's commit conventions; without them any commit message is accepted. */
  conventions?: (repo: RepoRef) => Promise<CommitConventions | undefined>
  /** Variables for checks and agent commands, e.g. the egress proxy; read when a task runs. Never secrets. */
  env?: () => Record<string, string> | undefined
  /** What the agent's `repos` tools ask the server. */
  links?: WriteTaskLinks
  /**
   * Called when a task starts on a worker, before anything else, with the job's id. Throwing
   * (e.g. `WriteTaskRefusedError` for a job no approved task queued) stops the task.
   */
  onStart?: (repo: RepoRef, options: WriteTaskOptions, jobId: string | undefined) => Promise<void>
}

const disabled = async (): Promise<WriteTaskPolicy> => ({ enabled: false, readOnly: false })

/**
 * The `write-task` analyzer (see `runWriteTask`): scope `repo`, pool `write`, so only dedicated
 * write workers claim it (it works in its own checkout, so other jobs of the repository go on); needs the forge and, unless the patch suffices, an agent. It
 * never runs on its own (no `refresh`).
 */
export function createWriteTaskAnalyzer(deps: WriteTaskAnalyzerDeps = {}): AnyAnalyzer {
  const policyOf = deps.policy ?? disabled
  return defineAnalyzer({
    kind: WRITE_TASK_KIND,
    analysis: writeTaskAnalysis,
    scope: 'repo',
    pool: WRITE_POOL,
    needs: { forge: true, agent: 'optional' },
    options: writeTaskOptionsSchema,
    async run(context) {
      const { forge, checkout } = context
      if (!forge || !checkout) throw new Error('write tasks need the forge and checkouts')
      await deps.onStart?.(context.repo, context.options, context.jobId)
      const conventions = await deps.conventions?.(context.repo).catch(() => undefined)
      const env = deps.env?.()
      const data = await runWriteTask({
        repo: context.repo,
        options: context.options,
        policy: await policyOf(context.repo),
        forge,
        checkout,
        ...(context.agent && { agent: context.agent }),
        ...(conventions && { conventions }),
        ...(env && { env }),
        ...(deps.links && { links: deps.links }),
        ...(context.signal && { signal: context.signal }),
        ...(context.log && { log: context.log }),
        ...(context.step && { step: context.step }),
      })
      return { data }
    },
  })
}

/** The analyzer with write tasks turned off, for registries without server state. */
export const writeTaskAnalyzer = createWriteTaskAnalyzer()
