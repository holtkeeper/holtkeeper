import type { AiUsageRecord, AiUsageTotals, PersonView } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'
import { useState } from 'react'

import { useAiRuns } from '../../api/queries.ts'
import { featureLabel, featureOf } from '../../lib/ai-features.ts'
import { formatTokens, formatUsd, runStarter, tokensNote, totalTokens } from '../../lib/ai-usage.ts'
import { formatDateTime, formatDuration, formatRelative, shortId } from '../../lib/format.ts'
import { repoSplat } from '../../lib/repo.ts'
import {
  Count,
  Dot,
  EmptyState,
  ErrorState,
  ListFooter,
  LoadMore,
  Placeholder,
  SegmentedTabs,
  Table,
  Tag,
  Td,
  Th,
} from '../../ui/index.ts'

const outcomes = ['all', 'error', 'denied-budget'] as const
type Outcome = (typeof outcomes)[number]

const outcomeView = {
  ok: { tone: 'success', label: 'Succeeded' },
  error: { tone: 'danger', label: 'Error' },
  'denied-budget': { tone: 'code', label: 'Blocked by budget' },
} as const

function Starter({ run, people }: { run: AiUsageRecord; people: Record<string, PersonView> }) {
  const starter = runStarter(run, people)
  if (starter.kind === 'job')
    return (
      <Link
        to="/ops/runs/$jobId"
        params={{ jobId: starter.id }}
        className="font-mono text-muted hover:underline"
      >
        Job {shortId(starter.id)}
      </Link>
    )
  if (starter.kind === 'analysis')
    return (
      <Link
        to="/analyses/$id"
        params={{ id: starter.id }}
        search={{}}
        className="font-mono text-muted hover:underline"
      >
        Analysis {shortId(starter.id)}
      </Link>
    )
  if (starter.kind === 'person') return <span title={starter.actor}>{starter.name}</span>
  return <span className="font-mono text-muted">{starter.actor}</span>
}

function RunRow({ run, people }: { run: AiUsageRecord; people: Record<string, PersonView> }) {
  const outcome = outcomeView[run.outcome]
  const denied = run.outcome === 'denied-budget'
  return (
    <tr>
      <Td className="whitespace-nowrap">
        <time
          dateTime={run.at}
          title={formatDateTime(run.at)}
          className="font-mono text-xs text-muted"
        >
          {formatRelative(run.at)}
        </time>
      </Td>
      <Td>
        <Tag>{featureLabel[featureOf(run.taskKind)]}</Tag>
      </Td>
      <Td>
        <Link
          to="/repos/$"
          params={{ _splat: repoSplat(run.repo) }}
          className="font-mono text-xs hover:underline"
        >
          {run.repo.path}
        </Link>
      </Td>
      <Td>
        <div className="flex flex-col">
          <span>{run.subject ?? run.taskKind}</span>
          <small className="font-mono text-[11px] text-dim">
            {[run.taskKind, run.analyzer].filter(Boolean).join(' · ')}
          </small>
        </div>
      </Td>
      <Td>
        <div className="flex flex-col">
          <span className="font-mono text-xs">{denied && !run.model ? '—' : run.model}</span>
          <small className="text-[11px] text-dim">{run.provider}</small>
        </div>
      </Td>
      <Td align="right">
        <div className="flex flex-col items-end">
          <span
            className="font-mono text-xs"
            title={`${run.inputTokens} in · ${run.outputTokens} out · ${run.cacheReadTokens} cache read · ${run.cacheWriteTokens} cache write`}
          >
            {formatTokens(totalTokens(run))}
          </span>
          <small className="whitespace-nowrap font-mono text-[11px] text-dim">
            {tokensNote(run)}
          </small>
        </div>
      </Td>
      <Td align="right" className="whitespace-nowrap font-mono text-xs">
        {run.costSource === 'unknown' && !denied ? (
          <span className="text-dim">unknown</span>
        ) : (
          formatUsd(run.costUsd)
        )}
      </Td>
      <Td align="right" className="whitespace-nowrap font-mono text-xs text-muted">
        {denied ? '—' : formatDuration(run.durationMs)}
      </Td>
      <Td>
        <div className="flex flex-col">
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
            <Dot tone={outcome.tone} />
            {outcome.label}
          </span>
          {run.error ? (
            <small
              className="line-clamp-2 max-w-64 break-words text-[11px] text-dim"
              title={run.error}
            >
              {run.error}
            </small>
          ) : null}
        </div>
      </Td>
      <Td className="whitespace-nowrap text-xs">
        <Starter run={run} people={people} />
      </Td>
    </tr>
  )
}

/** What the page's toolbar narrows the runs to. */
export interface SpendRunsFilter {
  origin?: 'interactive' | 'automatic'
  taskKind?: string
  model?: string
  /** Comma list of config groups. */
  groups?: string
}

/**
 * Every model run since `from`, newest first, paged by time: outcome segments with the period's
 * counts, narrowed by the page's toolbar (`filter`: who started it, task kind, model and scope)
 * through `GET /api/ai/runs`. The counts show only while nothing but the scope narrows.
 */
export function SpendRuns({
  from,
  totals,
  filter,
}: {
  from: string
  totals: AiUsageTotals
  filter: SpendRunsFilter
}) {
  const [outcome, setOutcome] = useState<Outcome>('all')
  const runs = useAiRuns({ from, ...filter, ...(outcome === 'all' ? {} : { outcome }) })
  const list = runs.data?.pages.flatMap((page) => page.runs) ?? []
  const people: Record<string, PersonView> = {}
  for (const page of runs.data?.pages ?? []) Object.assign(people, page.people)
  const counted = !filter.origin && !filter.taskKind && !filter.model
  const total =
    outcome === 'error' ? totals.errors : outcome === 'denied-budget' ? totals.denied : totals.runs
  const more = runs.hasNextPage ? (
    <LoadMore
      onLoad={() => void runs.fetchNextPage()}
      isPending={runs.isFetchingNextPage}
      size="sm"
    >
      Load older
    </LoadMore>
  ) : null
  const count = (value: number) => (counted ? <Count>{value.toLocaleString('en')}</Count> : null)

  return (
    <section className="flex min-w-0 flex-col gap-3 border-t border-line pt-3">
      <header className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold">Model runs</h2>
          <p className="text-xs text-muted">
            Every run that called a model in this period, newest first
          </p>
        </div>
        <span className="flex-1" />
        <SegmentedTabs
          aria-label="Run outcome"
          items={[
            { id: 'all', label: <>All {count(totals.runs)}</> },
            { id: 'error', label: <>Errors {count(totals.errors)}</> },
            { id: 'denied-budget', label: <>Blocked by budget {count(totals.denied)}</> },
          ]}
          selected={outcome}
          onSelect={(id) => setOutcome(outcomes.find((o) => o === id) ?? 'all')}
        />
      </header>
      {runs.isPending ? (
        <Placeholder className="h-64" />
      ) : runs.isError ? (
        <ErrorState error={runs.error} />
      ) : !list.length ? (
        <EmptyState
          icon={<Sparkles />}
          title="No model runs"
          description="Runs appear here once an analyzer, a task or chat calls a model."
        />
      ) : (
        <div className="flex flex-col">
          <Table label="Model runs">
            <thead>
              <tr>
                <Th sorted="descending">Time</Th>
                <Th>Feature</Th>
                <Th>Repository</Th>
                <Th>Task</Th>
                <Th>Model</Th>
                <Th align="right">Tokens</Th>
                <Th align="right">Cost</Th>
                <Th align="right">Duration</Th>
                <Th>Outcome</Th>
                <Th>Started by</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((run) => (
                <RunRow key={run.id} run={run} people={people} />
              ))}
            </tbody>
          </Table>
          {counted ? (
            <ListFooter
              shown={list.length}
              total={Math.max(total, list.length)}
              noun="runs"
              caption="· Tokens = input, output and cache"
              more={more}
            />
          ) : runs.hasNextPage ? (
            <div className="px-3.5 py-2.5">{more}</div>
          ) : null}
        </div>
      )}
    </section>
  )
}
