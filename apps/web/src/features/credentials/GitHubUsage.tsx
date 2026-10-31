import type {
  Block,
  GitHubLimitView,
  GitHubRequestCounts,
  GitHubTokenUsage,
  GitHubTokenView,
} from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, ChevronDown, Copy } from 'lucide-react'
import { useState } from 'react'

import { ApiError } from '../../api/client.ts'
import { formatDateTime, formatDuration, formatRelative, plural } from '../../lib/format.ts'
import {
  type GitHubRange,
  byResource,
  dailyChart,
  formatCount,
  formatLimit,
  githubRanges,
  parseGitHubRange,
  savedShare,
  sumCounts,
  tokenName,
  utilization,
  utilizationColor,
} from '../../lib/github-usage.ts'
import {
  Chip,
  ErrorState,
  Notice,
  Panel,
  Placeholder,
  Segmented,
  StatCard,
  Tooltip,
} from '../../ui/index.ts'
import { ChartBlock } from '../reports/blocks/ChartBlock.tsx'

type ChartBlockData = Extract<Block, { type: 'chart' }>

/** Whether a usage request failed because the caller may not see it or the server has none. */
export const usageHidden = (error: unknown) =>
  error instanceof ApiError && (error.status === 403 || error.status === 404)

/** What the GitHub tokens did together: pool capacity, totals and requests per day. */
export function GitHubUsageSection({
  days,
  onDaysChange,
  usage,
}: {
  days: GitHubRange
  onDaysChange: (days: GitHubRange) => void
  usage: { data?: GitHubTokenUsage; isPending: boolean; error: unknown }
}) {
  return (
    <Panel
      title="GitHub API usage"
      description={`Requests sent to GitHub over the last ${days} days by every github token, and what the pool has left`}
      actions={
        <Segmented
          aria-label="Range"
          value={String(days)}
          onChange={(value) => onDaysChange(parseGitHubRange(value) ?? days)}
          options={githubRanges.map((range) => ({ id: String(range), label: `${range} days` }))}
        />
      }
    >
      {usage.isPending ? (
        <Placeholder className="h-48" />
      ) : usage.data ? (
        <PoolUsage usage={usage.data} />
      ) : (
        <ErrorState error={usage.error} />
      )}
    </Panel>
  )
}

function PoolUsage({ usage }: { usage: GitHubTokenUsage }) {
  const capacity = byResource(usage.capacity)
  const chart = dailyChart(usage)
  const anonymous = sumCounts(usage.anonymous)
  const saved = savedShare(usage.totals)
  const block: ChartBlockData = {
    type: 'chart',
    title: 'Requests per day',
    chart: 'stacked-bar',
    unit: 'count',
    x: 'day',
    series: chart.series,
    data: chart.data,
  }
  return (
    <div className="flex flex-col gap-5">
      {capacity.length ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Pool capacity</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {capacity.map(([resource, limit]) => (
              <div key={resource} className="rounded-xl border border-border px-3 py-2.5">
                <LimitBar resource={resource} limit={limit} />
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Requests"
          value={usage.totals.requests}
          hint={`last ${usage.days.length} days`}
        />
        <StatCard
          label="Saved by the cache"
          value={usage.totals.notModified}
          hint={saved === undefined ? 'answered 304' : `${saved}% answered 304, not counted`}
          accent="var(--success)"
        />
        <StatCard
          label="Rate-limited answers"
          value={usage.totals.limited}
          hint="primary or secondary limit"
          {...(usage.totals.limited ? { accent: 'var(--warning)' } : {})}
        />
        <StatCard
          label="Waits for a reset"
          value={usage.totals.waits}
          hint={
            usage.totals.waits
              ? `${formatDuration(usage.totals.waitMs)} waited in all`
              : 'the tokens never ran out'
          }
          {...(usage.totals.waits ? { accent: 'var(--warning)' } : {})}
        />
      </div>
      {chart.series.length ? <ChartBlock block={block} /> : null}
      {usage.tokens.length === 0 ? (
        <Notice tone="warning" title="No GitHub token">
          GitHub allows 60 anonymous requests an hour, which the library index spends on its first
          few libraries. Add a credential of kind github: every one is used, and a new index run
          starts with it. The <code className="font-mono text-xs">github</code> field of the{' '}
          <Link
            to="/settings"
            search={{ tab: 'libraries' }}
            className="font-medium hover:underline"
          >
            libraries setting
          </Link>{' '}
          picks some of them instead, and an empty list keeps GitHub anonymous.
          {anonymous.requests
            ? ` ${plural(anonymous.requests, 'anonymous request')} in the range.`
            : null}
        </Notice>
      ) : anonymous.requests ? (
        <p className="text-xs text-muted">
          {plural(anonymous.requests, 'request')} went without a token (60 an hour), e.g. before the
          first token was added.
        </p>
      ) : null}
    </div>
  )
}

function LimitBar({ resource, limit }: { resource: string; limit: GitHubLimitView }) {
  const percent = utilization(limit)
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-foreground">{resource}</span>
        <span className="tabular text-muted">{formatLimit(limit)}</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-default"
        role="meter"
        aria-label={`${resource} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${percent}%`, background: utilizationColor(percent) }}
        />
      </div>
      <div className="flex justify-between gap-3 text-muted">
        <span className="tabular">{formatCount(limit.remaining)} left</span>
        <Tooltip content={formatDateTime(limit.resetAt)}>
          <span tabIndex={0}>resets {formatRelative(limit.resetAt)}</span>
        </Tooltip>
      </div>
    </div>
  )
}

/**
 * The usage of one github credential inside its card: account, the `core` limit and counts at a
 * glance, every limit and the per-resource counts when expanded. `token` is absent when the
 * library index does not use the credential.
 */
export function GitHubCredentialUsage({
  token,
  tokens,
  days,
}: {
  token: GitHubTokenView | undefined
  tokens: readonly GitHubTokenView[]
  days: number
}) {
  const [open, setOpen] = useState(false)
  if (!token)
    return (
      <p className="text-xs text-muted">
        Not used by the library index: the <code className="font-mono">github</code> field of the
        libraries setting lists other credentials.
      </p>
    )
  const limits = byResource(token.limits)
  const core = limits.find(([resource]) => resource === 'core')
  const total = sumCounts(token.usage)
  const share = savedShare(total)
  const resources = byResource(token.usage)
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-separator p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-medium text-foreground">
          {token.login ? `@${token.login}` : 'GitHub account unknown'}
        </span>
        <span className="tabular text-muted">
          {formatCount(total.requests)} requests in {days} days
          {share === undefined ? '' : ` · ${share}% from the cache`}
          {total.limited ? ` · ${formatCount(total.limited)} limited` : ''}
        </span>
      </div>
      {token.duplicateOf || token.error ? (
        <div className="flex flex-wrap gap-1">
          {token.duplicateOf ? (
            <Chip tone="warning">
              <Copy className="size-3" />
              same account as {tokenName(tokens, token.duplicateOf)}: shares its limit, not used
            </Chip>
          ) : null}
          {token.error ? (
            <Tooltip content={token.error}>
              <span tabIndex={0} className="inline-flex max-w-full">
                <Chip tone="danger">
                  <AlertTriangle className="size-3" />
                  <span className="truncate">{token.error}</span>
                </Chip>
              </span>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
      {core ? <LimitBar resource={core[0]} limit={core[1]} /> : null}
      {limits.length || resources.length ? (
        <button
          type="button"
          className="flex items-center gap-1 self-start text-xs font-medium text-muted hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
          {open ? 'Hide details' : 'Usage details'}
        </button>
      ) : null}
      {open ? (
        <div className="flex flex-col gap-3">
          {limits.filter(([resource]) => resource !== 'core').length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {limits
                .filter(([resource]) => resource !== 'core')
                .map(([resource, limit]) => (
                  <LimitBar key={resource} resource={resource} limit={limit} />
                ))}
            </div>
          ) : null}
          {resources.length ? <Breakdown resources={resources} /> : null}
        </div>
      ) : null}
    </section>
  )
}

function Breakdown({ resources }: { resources: [string, GitHubRequestCounts][] }) {
  return (
    <table className="text-xs">
      <thead>
        <tr className="text-muted">
          <th className="pr-3 text-left font-normal">Resource</th>
          <th className="px-2 text-right font-normal">Requests</th>
          <th className="px-2 text-right font-normal">From cache (304)</th>
          <th className="pl-2 text-right font-normal">Limited</th>
        </tr>
      </thead>
      <tbody>
        {resources.map(([resource, counts]) => (
          <tr key={resource}>
            <td className="pr-3 font-mono">{resource}</td>
            <td className="tabular px-2 text-right">{formatCount(counts.requests)}</td>
            <td className="tabular px-2 text-right">{formatCount(counts.notModified)}</td>
            <td className="tabular pl-2 text-right">{formatCount(counts.limited)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
