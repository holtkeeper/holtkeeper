import type { ActivityPerson, AnalysisSummary, Metric } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { motion } from 'motion/react'
import { useState } from 'react'

import { type RepoLatest, latestPerRepo, withDeltas } from '../../lib/analyses.ts'
import { formatDateTime, formatRef, formatRelative } from '../../lib/format.ts'
import { splitRepoPath } from '../../lib/repo.ts'
import { formatValue } from '../../lib/units.ts'
import { Avatar, Segmented, fadeItem, stagger } from '../../ui/index.ts'
import { MiniSparkline } from '../../ui/MiniSparkline.tsx'
import { RepoAvatar } from '../repos/RepoAvatar.tsx'
import { MetricTiles } from './MetricTiles.tsx'

type Sort = 'name' | 'recent' | 'metric'

function Person({
  id,
  people,
}: {
  id: string | undefined
  people: Record<string, ActivityPerson>
}) {
  if (!id) return null
  const person = people[id]
  if (!person) return null
  return (
    <span className="inline-flex items-center gap-1">
      <Avatar src={person.avatarUrl} name={person.name} size="xs" />
      {person.name}
    </span>
  )
}

function RepoCard({
  card,
  trend,
  people,
}: {
  card: RepoLatest
  trend: Metric | undefined
  people: Record<string, ActivityPerson>
}) {
  const { latest } = card
  const { namespace, name } = splitRepoPath(latest.repo.path)
  const now = new Date()
  return (
    <motion.li {...fadeItem} className="min-w-0">
      <Link
        to="/analyses/$id"
        params={{ id: latest.id }}
        search={{}}
        className="group flex h-full flex-col gap-3 rounded-2xl bg-surface p-4 shadow-surface transition-shadow hover:shadow-overlay focus-visible:outline-2 focus-visible:outline-focus"
      >
        <div className="flex items-start gap-3">
          <RepoAvatar repo={latest.repo} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold leading-tight group-hover:text-accent">
              {name}
            </div>
            <div className="truncate text-xs text-muted" title={latest.repo.path}>
              {namespace.replace(/\/$/, '') || latest.repo.forge}
            </div>
          </div>
          <span
            className="shrink-0 text-xs whitespace-nowrap text-muted"
            title={formatDateTime(latest.createdAt)}
          >
            {formatRelative(latest.createdAt, now)}
          </span>
        </div>
        <MetricTiles metrics={card.metrics} />
        {trend && card.series.length > 1 ? (
          <div className="flex items-end gap-3">
            <MiniSparkline
              values={card.series}
              label={`${trend.label} across ${card.series.length} runs`}
            />
            <span className="shrink-0 pb-0.5 text-[11px] text-muted">
              {trend.label}
              <br />
              <span className="tabular">
                {formatValue(card.series[0], trend.unit)} →{' '}
                {formatValue(card.series.at(-1), trend.unit)}
              </span>
            </span>
          </div>
        ) : null}
        <div className="mt-auto flex items-center justify-between gap-2 text-[11px] text-muted">
          <span>
            {card.count} {card.count === 1 ? 'run' : 'runs'}
            {latest.ref ? (
              <span className="ml-1 font-mono" title={latest.ref}>
                · {formatRef(latest.ref)}
              </span>
            ) : null}
          </span>
          <Person id={latest.actor} people={people} />
        </div>
      </Link>
    </motion.li>
  )
}

/** The newest record of every repository (or group) as cards, sortable by name, recency or a metric. */
export function RepoCards({
  analyses,
  trend,
  people,
  noun = ['repository', 'repositories'],
}: {
  analyses: readonly AnalysisSummary[]
  trend: Metric | undefined
  people: Record<string, ActivityPerson>
  /** What each card stands for, singular and plural; group analyses pass `group`. */
  noun?: readonly [string, string]
}) {
  const [sort, setSort] = useState<Sort>('name')
  const cards = latestPerRepo(analyses, trend?.id)
  const valueOf = (card: RepoLatest) => {
    const value = card.metrics.find((m) => m.id === trend?.id)?.value
    return typeof value === 'number' ? value : Number.NEGATIVE_INFINITY
  }
  const sorted = cards.toSorted((a, b) =>
    sort === 'recent'
      ? b.latest.createdAt.localeCompare(a.latest.createdAt)
      : sort === 'metric'
        ? valueOf(b) - valueOf(a)
        : a.latest.repo.path.localeCompare(b.latest.repo.path),
  )
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-muted">
          {cards.length} {cards.length === 1 ? noun[0] : noun[1]}, newest run of each
        </span>
        <Segmented
          aria-label="Sort"
          value={sort}
          onChange={setSort}
          options={[
            { id: 'name', label: 'Name' },
            { id: 'recent', label: 'Recent' },
            ...(trend ? [{ id: 'metric' as const, label: trend.label }] : []),
          ]}
        />
      </div>
      <motion.ul {...stagger} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" key={sort}>
        {sorted.map((card) => (
          <RepoCard
            key={`${card.latest.repo.forge}:${card.latest.repo.path}`}
            card={card}
            trend={trend}
            people={people}
          />
        ))}
      </motion.ul>
    </div>
  )
}

/** Records of one repository, newest first, each with its change since the one before. */
export function RecordRows({
  analyses,
  people,
}: {
  analyses: readonly AnalysisSummary[]
  people: Record<string, ActivityPerson>
}) {
  const now = new Date()
  return (
    <motion.ul {...stagger} className="divide-y divide-separator">
      {analyses.map((analysis, index) => (
        <motion.li key={analysis.id} {...fadeItem}>
          <Link
            to="/analyses/$id"
            params={{ id: analysis.id }}
            search={{}}
            className="grid items-center gap-x-6 gap-y-2 px-4 py-3 transition-colors hover:bg-default-soft focus-visible:bg-default-soft focus-visible:outline-none md:grid-cols-[13rem_minmax(0,1fr)_auto]"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium" title={formatDateTime(analysis.createdAt)}>
                {formatRelative(analysis.createdAt, now)}
                {analysis.ref ? (
                  <span className="ml-2 font-mono text-xs text-muted" title={analysis.ref}>
                    {formatRef(analysis.ref)}
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                {formatDateTime(analysis.createdAt)}
                {analysis.actor && people[analysis.actor] ? (
                  <>
                    <span>·</span>
                    <Person id={analysis.actor} people={people} />
                  </>
                ) : null}
              </div>
            </div>
            <MetricTiles
              metrics={withDeltas(analysis.metrics, analyses[index + 1]?.metrics)}
              limit={4}
              className="grid grid-cols-2 gap-2 lg:grid-cols-4"
            />
            <ChevronRight className="hidden size-4 text-muted md:block" />
          </Link>
        </motion.li>
      ))}
    </motion.ul>
  )
}
