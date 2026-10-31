import type { AiUsageRecord } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'

import { useAiRuns } from '../../api/queries.ts'
import { formatTokens, formatUsd, totalTokens } from '../../lib/ai-usage.ts'
import { formatDateTime, formatDuration, formatRelative } from '../../lib/format.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Chip,
  EmptyState,
  ErrorState,
  LoadMore,
  Placeholder,
  Table,
  Td,
  Th,
  Tooltip,
} from '../../ui/index.ts'

const noFilter = {}

function Outcome({ run }: { run: AiUsageRecord }) {
  if (run.outcome === 'ok') return <Chip tone="success">ok</Chip>
  const chip = (
    <Chip tone={run.outcome === 'error' ? 'danger' : 'warning'}>
      {run.outcome === 'error' ? 'error' : 'over budget'}
    </Chip>
  )
  return run.error ? (
    <Tooltip content={<span className="block max-w-80 break-words">{run.error}</span>}>
      <span tabIndex={0} className="inline-flex">
        {chip}
      </span>
    </Tooltip>
  ) : (
    chip
  )
}

/** Individual AI runs, newest first, with links to their job and analysis. */
export function RunsTable() {
  const runs = useAiRuns(noFilter)
  const list = runs.data?.pages.flatMap((page) => page.runs) ?? []

  if (runs.isPending) return <Placeholder className="h-64" />
  if (runs.isError) return <ErrorState error={runs.error} />
  if (!list.length)
    return (
      <EmptyState
        icon={<Sparkles />}
        title="No AI runs yet"
        description="Runs appear here once an analyzer or job calls a model."
      />
    )

  return (
    <div className="flex flex-col gap-3">
      <Table
        label="AI runs"
        footer={
          runs.hasNextPage ? (
            <LoadMore onLoad={() => void runs.fetchNextPage()} isPending={runs.isFetchingNextPage}>
              Load older
            </LoadMore>
          ) : null
        }
      >
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Repository</Th>
            <Th>Task</Th>
            <Th>Model</Th>
            <Th align="right">Tokens</Th>
            <Th align="right">Cost</Th>
            <Th align="right">Duration</Th>
            <Th>Outcome</Th>
            <Th>Source</Th>
          </tr>
        </thead>
        <tbody>
          {list.map((run) => (
            <tr key={run.id}>
              <Td className="whitespace-nowrap text-xs text-muted">
                <time dateTime={run.at} title={formatDateTime(run.at)}>
                  {formatRelative(run.at)}
                </time>
              </Td>
              <Td>
                <Link
                  to="/repos/view"
                  search={{ repo: repoKey(run.repo) }}
                  className="font-medium hover:underline"
                >
                  {run.repo.path}
                </Link>
              </Td>
              <Td>
                <div>{run.taskKind}</div>
                {run.analyzer ? <div className="text-xs text-muted">{run.analyzer}</div> : null}
              </Td>
              <Td>
                <div className="font-mono text-xs">{run.model}</div>
                <div className="text-xs text-muted">{run.provider}</div>
              </Td>
              <Td align="right" className="tabular whitespace-nowrap">
                <Tooltip
                  content={`${run.inputTokens} in · ${run.outputTokens} out · ${run.cacheReadTokens} cache read · ${run.cacheWriteTokens} cache write`}
                >
                  <span tabIndex={0}>{formatTokens(totalTokens(run))}</span>
                </Tooltip>
              </Td>
              <Td align="right" className="tabular whitespace-nowrap">
                {run.costSource === 'unknown' ? (
                  <span className="text-muted">unknown</span>
                ) : (
                  formatUsd(run.costUsd)
                )}
              </Td>
              <Td align="right" className="tabular whitespace-nowrap text-muted">
                {run.outcome === 'denied-budget' ? '—' : formatDuration(run.durationMs)}
              </Td>
              <Td>
                <Outcome run={run} />
              </Td>
              <Td className="whitespace-nowrap text-xs">
                <div className="flex flex-col gap-0.5">
                  {run.jobId ? (
                    <Link
                      to="/jobs/$jobId"
                      params={{ jobId: run.jobId }}
                      className="text-accent hover:underline"
                    >
                      Job
                    </Link>
                  ) : null}
                  {run.analysisId ? (
                    <Link
                      to="/analyses/$id"
                      params={{ id: run.analysisId }}
                      search={{}}
                      className="text-accent hover:underline"
                    >
                      Analysis
                    </Link>
                  ) : null}
                  {!run.jobId && !run.analysisId ? (
                    <span className="text-muted">{run.actor}</span>
                  ) : null}
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  )
}
