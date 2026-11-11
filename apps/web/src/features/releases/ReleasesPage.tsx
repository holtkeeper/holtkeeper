import type { ReleaseCard } from '@holtkeeper/api'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowRight, RefreshCw, Rocket } from 'lucide-react'
import { useState } from 'react'

import { useReleaseActions, useReleaseOverview, useRepos } from '../../api/queries.ts'
import { formatRelative, plural } from '../../lib/format.ts'
import { cardTicks, countLabel, nextStep, sortCards } from '../../lib/releases.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  Notice,
  Page,
  Placeholder,
  ScopeSwitch,
  Segmented,
  Select,
  TickStrip,
} from '../../ui/index.ts'
import { RepoLink } from '../repos/RepoLink.tsx'
import { useScope } from '../shell/scope.ts'
import { BumpTag, StageTag } from './parts.tsx'

const filters = [
  { id: 'action', label: 'Needs action' },
  { id: 'all', label: 'All' },
] as const

function Card({ card }: { card: ReleaseCard }) {
  const ticks = cardTicks(card)
  const step = nextStep(card)
  return (
    <article className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-3.5">
      <header className="flex items-start justify-between gap-2">
        <RepoLink repo={card.repo} to="/releases/$" />
        <StageTag row={card} />
      </header>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="mono text-[15px] font-semibold">{card.latest?.tag ?? 'no version'}</span>
        {card.latest?.date ? (
          <span className="text-xs text-dim">{formatRelative(card.latest.date)}</span>
        ) : null}
        {card.next ? (
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted">
            next <span className="mono text-foreground">{card.next}</span>
            <BumpTag bump={card.bump} />
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted">
        {card.error ? (
          <span className="text-bad">{card.error}</span>
        ) : card.unreleased || card.ahead ? (
          <>
            {card.unreleased ? (
              <>
                <span className="tabular text-foreground">
                  {countLabel(card.unreleased, card.unreleasedCapped)}
                </span>{' '}
                unreleased on {card.target}
              </>
            ) : null}
            {card.unreleased && card.ahead ? ' · ' : null}
            {card.ahead ? (
              <>
                <span className="tabular text-foreground">
                  {countLabel(card.ahead, card.aheadCapped)}
                </span>{' '}
                on {card.source}
              </>
            ) : null}
            {card.tickets.length ? ` · ${plural(card.tickets.length, 'task')}` : null}
          </>
        ) : (
          'Everything is released'
        )}
      </p>
      {ticks.length ? (
        <TickStrip ticks={ticks} aria-label={ticks.map((tick) => tick.label).join(', ')} />
      ) : null}
      {step ? (
        <Link
          to="/releases/$"
          params={{ _splat: repoKey(card.repo) }}
          className="inline-flex items-center gap-1 self-start text-xs font-medium text-[var(--brand)] hover:underline"
        >
          {step}
          <ArrowRight className="size-3" />
        </Link>
      ) : null}
    </article>
  )
}

/**
 * Every repository with releases on, as one card each: latest version, what waits, the next bump,
 * where it stands and its pipelines and deploys. Scoped to the viewer's team by default.
 */
export function ReleasesPage() {
  const overview = useReleaseOverview()
  const repos = useRepos()
  const actions = useReleaseActions()
  const { view, setView, scope } = useScope()
  const navigate = useNavigate()
  const [filter, setFilter] = useState<(typeof filters)[number]['id']>('action')

  const groupsOf = new Map(
    (repos.data?.repos ?? []).map((summary) => [repoKey(summary.repo), summary.groups]),
  )
  const cards = (overview.data?.cards ?? []).map((card) => ({
    ...card,
    groups: groupsOf.get(repoKey(card.repo)) ?? [],
  }))
  const scoped = repos.data ? scope(cards) : undefined
  const inScope = scoped ? scoped.shown : cards
  const waiting = inScope.filter((card) => card.needsAction)
  const shown = sortCards(filter === 'action' ? waiting : inScope)
  const listed = new Set(cards.map((card) => repoKey(card.repo)))
  const unlisted = (repos.data?.repos ?? [])
    .filter((summary) => summary.configurable)
    .map((summary) => repoKey(summary.repo))
    .filter((key) => !listed.has(key))
    .toSorted()

  return (
    <Page
      title="Releases"
      icon="releaseboard"
      description={
        overview.data
          ? `Read from the forges ${formatRelative(overview.data.readAt)}${overview.data.refreshing ? ' · reading again…' : ''}`
          : 'Versions, release merge requests and deploys of every repository with releases on'
      }
      actions={
        <>
          {scoped ? <ScopeSwitch value={view} onChange={setView} counts={scoped.counts} /> : null}
          <Segmented
            aria-label="Filter"
            options={filters.map((option) => ({
              id: option.id,
              label:
                option.id === 'action' ? (
                  <span className="inline-flex items-center gap-1.5">
                    {option.label}
                    <span className="tabular text-muted">{waiting.length}</span>
                  </span>
                ) : (
                  option.label
                ),
            }))}
            value={filter}
            onChange={setFilter}
          />
          {unlisted.length ? (
            <Select
              aria-label="Set up releases for a repository"
              placeholder="Set up a repository…"
              className="w-56"
              options={unlisted.map((key) => ({
                id: key,
                label: <span className="mono text-xs">{key}</span>,
                text: key,
              }))}
              value={undefined}
              onChange={(key) =>
                void navigate({
                  to: '/releases/$',
                  params: { _splat: key },
                  search: { tab: 'flow' },
                })
              }
            />
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            onPress={() => actions.refresh.mutate()}
            isPending={actions.refresh.isPending || overview.data?.refreshing === true}
          >
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        </>
      }
    >
      {overview.data?.dryRun ? (
        <Notice tone="warning" title="Dry run">
          The server runs with dryRun: steps report what they would do and change nothing.
        </Notice>
      ) : null}
      {overview.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Placeholder key={i} className="h-36" />
          ))}
        </div>
      ) : overview.isError ? (
        <ErrorState error={overview.error} />
      ) : view === 'others' && scoped ? (
        <p className="text-sm text-muted">
          {plural(scoped.others.items, 'repository', 'repositories')} of other teams release here.{' '}
          <button
            type="button"
            className="text-foreground hover:underline"
            onClick={() => setView('all')}
          >
            Show them
          </button>
        </p>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<Rocket />}
          title={
            filter === 'action' && inScope.length ? 'Nothing waits for you' : 'No repositories'
          }
          description={
            filter === 'action' && inScope.length
              ? 'No version waits, no release merge request is open and no deploy failed.'
              : 'Pick a repository under Set up a repository and turn releases on in its flow.'
          }
          {...(filter === 'action' && inScope.length
            ? {
                action: (
                  <Button variant="secondary" onPress={() => setFilter('all')}>
                    Show all
                  </Button>
                ),
              }
            : {})}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((card) => (
            <Card key={repoKey(card.repo)} card={card} />
          ))}
        </div>
      )}
    </Page>
  )
}
