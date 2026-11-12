import type { AiUsagePeriodKind } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

import { useAiUsage } from '../../api/queries.ts'
import { featureItems } from '../../lib/ai-features.ts'
import {
  type CostItem,
  costItems,
  formatUsd,
  periodLabel,
  topWithRest,
} from '../../lib/ai-usage.ts'
import { plural } from '../../lib/format.ts'
import { parseRepoKey, repoSplat } from '../../lib/repo.ts'
import { ErrorState, Panel, Placeholder } from '../../ui/index.ts'

const rowClass =
  'grid grid-cols-[minmax(0,1.1fr)_minmax(60px,1fr)_72px] items-center gap-2.5 py-[3px] text-[12.5px]'

function Track({ item, top }: { item: CostItem; top: number }) {
  return (
    <span
      className="h-2 overflow-hidden rounded bg-sunk shadow-[inset_0_0_0_1px_var(--line)]"
      role="img"
      aria-label={`${item.name}: ${formatUsd(item.costUsd)}`}
    >
      <b
        className="block h-full rounded"
        style={{
          width: `${top > 0 ? (item.costUsd / top) * 100 : 0}%`,
          background: 'color-mix(in oklab, var(--fg) 62%, transparent)',
        }}
      />
    </span>
  )
}

function Cost({ item }: { item: CostItem }) {
  return (
    <span className="text-right font-mono">
      {item.costUsd === 0 && item.unknownCost > 0 ? (
        <span className="text-dim">unknown</span>
      ) : (
        formatUsd(item.costUsd)
      )}
    </span>
  )
}

function Rows<T extends CostItem>({
  items,
  name,
}: {
  items: readonly T[]
  name: (item: T) => ReactNode
}) {
  if (!items.length) return <p className="text-xs text-muted">No runs in this period.</p>
  const top = Math.max(...items.map((item) => item.costUsd))
  return (
    <ul className="flex flex-col gap-[5px]">
      {items.map((item) => (
        <li key={item.name} className={rowClass}>
          <span className="min-w-0 truncate">{name(item)}</span>
          <Track item={item} top={top} />
          <Cost item={item} />
        </li>
      ))}
    </ul>
  )
}

function Breakdown({
  title,
  period,
  aside,
  query,
  children,
}: {
  title: string
  period: AiUsagePeriodKind
  aside?: ReactNode
  query: { isError: boolean; error: unknown; isPending: boolean }
  children: ReactNode
}) {
  return (
    <Panel
      variant="flush"
      title={
        <>
          {title} <small className="ml-1 font-normal text-dim">{periodLabel[period]}</small>
        </>
      }
      {...(aside ? { actions: aside } : {})}
      contentClassName="flex flex-col gap-2"
    >
      {query.isError ? (
        <ErrorState error={query.error} />
      ) : query.isPending ? (
        <Placeholder className="h-32" />
      ) : (
        children
      )}
    </Panel>
  )
}

const repoLimit = 8

/**
 * Spend of the overview's period split three ways: by feature (task kinds mapped by
 * `featureOf`), by repository (the top ones, the rest folded) and by model with its provider.
 */
export function Breakdowns({
  from,
  period,
  groups,
}: {
  from: string
  period: AiUsagePeriodKind
  /** Comma list of config groups the scope switch narrows to. */
  groups?: string
}) {
  const scope = groups ? { groups } : {}
  const features = useAiUsage({ groupBy: 'taskKind', from, ...scope })
  const repos = useAiUsage({ groupBy: 'repo', from, ...scope })
  const models = useAiUsage({ groupBy: 'model,provider', from, ...scope })

  const featureRows: CostItem[] = features.data
    ? featureItems(features.data.buckets).map((item) => ({
        name: item.label,
        costUsd: item.costUsd,
        runs: item.runs,
        unknownCost: item.unknownCost,
      }))
    : []
  const repoRows = repos.data
    ? topWithRest(costItems(repos.data.buckets, 'repo'), repoLimit)
    : undefined
  const modelRows = (models.data?.buckets ?? [])
    .map((bucket) => ({
      name: bucket.key.model || 'unknown',
      provider: bucket.key.provider ?? '',
      costUsd: bucket.costUsd,
      runs: bucket.runs,
      unknownCost: bucket.unknownCost,
    }))
    .toSorted((a, b) => b.costUsd - a.costUsd || b.runs - a.runs)
  const unpriced = modelRows.filter((row) => row.unknownCost > 0)

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Breakdown
        title="By feature"
        period={period}
        aside={<span className="text-xs text-muted">runs</span>}
        query={features}
      >
        <Rows
          items={featureRows}
          name={(item) => (
            <>
              {item.name} <span className="text-dim">{item.runs.toLocaleString('en')}</span>
            </>
          )}
        />
      </Breakdown>
      <Breakdown title="By repository" period={period} query={repos}>
        <Rows
          items={repoRows ? [...repoRows.top, ...(repoRows.rest ? [repoRows.rest] : [])] : []}
          name={(item) => {
            const repo = parseRepoKey(item.name)
            if (item === repoRows?.rest)
              return (
                <span className="text-muted">
                  {plural(repoRows.rest.count, 'other repository', 'other repositories')}
                </span>
              )
            return repo ? (
              <Link
                to="/repos/$"
                params={{ _splat: repoSplat(repo) }}
                className="font-mono hover:underline"
              >
                {repo.path}
              </Link>
            ) : (
              <span className="font-mono">{item.name}</span>
            )
          }}
        />
      </Breakdown>
      <Breakdown title="By model" period={period} query={models}>
        <Rows
          items={modelRows}
          name={(item) => (
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-mono">{item.name}</span>
              <small className="truncate text-[11px] text-dim">
                {item.provider ? `${item.provider} · ` : ''}
                {plural(item.runs, 'run')}
                {item.unknownCost ? ' · no price' : ''}
              </small>
            </span>
          )}
        />
        {unpriced.length ? (
          <p className="flex items-start gap-1.5 text-xs text-muted">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />
            <span>
              {[...new Set(unpriced.map((row) => row.name))].join(', ')}{' '}
              {unpriced.length === 1 ? 'has' : 'have'} no price, so{' '}
              {plural(
                unpriced.reduce((sum, row) => sum + row.unknownCost, 0),
                'run counts',
                'runs count',
              )}{' '}
              as $0.{' '}
              <Link
                to="/settings/$section"
                params={{ section: 'ai' }}
                className="text-foreground underline"
              >
                Providers and models
              </Link>
            </span>
          </p>
        ) : null}
      </Breakdown>
    </div>
  )
}
