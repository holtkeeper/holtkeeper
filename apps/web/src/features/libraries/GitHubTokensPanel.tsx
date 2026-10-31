import type {
  Block,
  GitHubLimitView,
  GitHubRequestCounts,
  GitHubTokenUsage,
  GitHubTokenView,
} from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, Copy } from 'lucide-react'
import type { ReactNode } from 'react'

import { ApiError } from '../../api/client.ts'
import { useGitHubTokens } from '../../api/queries.ts'
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
  Table,
  Td,
  Th,
  Tooltip,
} from '../../ui/index.ts'
import { ChartBlock } from '../reports/blocks/ChartBlock.tsx'

type ChartBlockData = Extract<Block, { type: 'chart' }>

const hidden = (error: unknown) =>
  error instanceof ApiError && (error.status === 403 || error.status === 404)

/** Use and live limits of the GitHub tokens the library indexer shares; hidden without access. */
export function GitHubTokensPanel({
  days,
  onDaysChange,
}: {
  days: GitHubRange
  onDaysChange: (days: GitHubRange) => void
}) {
  const usage = useGitHubTokens(days)
  if (hidden(usage.error)) return null
  return (
    <Panel
      title="GitHub tokens"
      description={`Requests the indexer sent to GitHub over the last ${days} days and what each token has left`}
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
        <Placeholder className="h-64" />
      ) : usage.isError ? (
        <ErrorState error={usage.error} />
      ) : (
        <Usage usage={usage.data} />
      )}
    </Panel>
  )
}

function Usage({ usage }: { usage: GitHubTokenUsage }) {
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
      {usage.tokens.length ? (
        <Table label="GitHub tokens">
          <thead>
            <tr>
              <Th>Token</Th>
              <Th>Live limits</Th>
              <Th align="right">Requests</Th>
              <Th align="right">Saved (304)</Th>
              <Th align="right">Limited</Th>
            </tr>
          </thead>
          <tbody>
            {usage.tokens.map((token) => (
              <TokenRow key={token.credentialId} token={token} tokens={usage.tokens} />
            ))}
            {anonymous.requests ? (
              <tr className="hover:bg-default/40">
                <Td>
                  <div className="font-medium">Anonymous</div>
                  <div className="text-xs text-muted">sent without a token, 60 an hour</div>
                </Td>
                <Td className="text-muted">—</Td>
                <CountCells usage={usage.anonymous} />
              </tr>
            ) : null}
          </tbody>
        </Table>
      ) : (
        <Notice tone="warning" title="No GitHub token configured">
          GitHub allows 60 anonymous requests an hour, which runs out on the first few libraries.
          Add a credential of kind github on the{' '}
          <Link to="/credentials" className="font-medium hover:underline">
            Credentials
          </Link>{' '}
          page and name it under <code className="font-mono text-xs">github</code> in the{' '}
          <Link
            to="/settings"
            search={{ tab: 'libraries' }}
            className="font-medium hover:underline"
          >
            libraries setting
          </Link>
          .
          {anonymous.requests
            ? ` ${plural(anonymous.requests, 'anonymous request')} in the range.`
            : null}
        </Notice>
      )}
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

function TokenRow({ token, tokens }: { token: GitHubTokenView; tokens: GitHubTokenView[] }) {
  const limits = byResource(token.limits)
  return (
    <tr className="align-top hover:bg-default/40">
      <Td className="max-w-[22rem]">
        <Link to="/credentials" className="font-medium hover:underline">
          {token.name}
        </Link>
        <div className="text-xs text-muted">
          {token.login ? `@${token.login}` : 'account unknown'}
        </div>
        {token.duplicateOf || token.error ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {token.duplicateOf ? (
              <Chip tone="warning">
                <Copy className="size-3" />
                duplicate of {tokenName(tokens, token.duplicateOf)} — shares its limit, not used
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
      </Td>
      <Td className="min-w-56">
        {limits.length ? (
          <div className="flex flex-col gap-2">
            {limits.map(([resource, limit]) => (
              <LimitBar key={resource} resource={resource} limit={limit} />
            ))}
          </div>
        ) : (
          <span className="text-muted">—</span>
        )}
      </Td>
      <CountCells usage={token.usage} />
    </tr>
  )
}

function CountCells({ usage }: { usage: Record<string, GitHubRequestCounts> }) {
  const total = sumCounts(usage)
  const resources = byResource(usage)
  const share = savedShare(total)
  const withBreakdown = (value: ReactNode) =>
    resources.length ? (
      <Tooltip content={<Breakdown resources={resources} />}>
        <span tabIndex={0} className="tabular underline decoration-dotted underline-offset-4">
          {value}
        </span>
      </Tooltip>
    ) : (
      <span className="tabular">{value}</span>
    )
  return (
    <>
      <Td align="right">{withBreakdown(formatCount(total.requests))}</Td>
      <Td align="right" className="tabular">
        {formatCount(total.notModified)}
        {share === undefined ? null : <span className="ml-1 text-xs text-muted">{share}%</span>}
      </Td>
      <Td align="right" className={total.limited ? 'tabular text-warning' : 'tabular'}>
        {formatCount(total.limited)}
      </Td>
    </>
  )
}

function Breakdown({ resources }: { resources: [string, GitHubRequestCounts][] }) {
  return (
    <table className="text-xs">
      <thead>
        <tr className="text-muted">
          <th className="pr-3 text-left font-normal">Resource</th>
          <th className="px-2 text-right font-normal">Requests</th>
          <th className="px-2 text-right font-normal">304</th>
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
