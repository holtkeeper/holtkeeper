import type { CiRepoCard } from '@holtkeeper/api'
import { Timer } from 'lucide-react'

import { useCiOverview, useRepos } from '../../api/queries.ts'
import { changeLabel, seconds, sortCiCards, successTone } from '../../lib/ci.ts'
import { formatRelative, plural } from '../../lib/format.ts'
import { repoKey } from '../../lib/repo.ts'
import { pageSettingKeys } from '../../lib/settings-tabs.ts'
import { statusColor } from '../../ui/colors.ts'
import { EmptyState, ErrorState, Page, Placeholder, ScopeSwitch, Tag } from '../../ui/index.ts'
import { MiniSparkline } from '../../ui/MiniSparkline.tsx'
import { RepoLink } from '../repos/RepoLink.tsx'
import { SettingsButton } from '../settings/SettingsSheet.tsx'
import { useScope } from '../shell/scope.ts'

function Card({ card }: { card: CiRepoCard }) {
  const change = changeLabel(card.change)
  return (
    <article className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-3.5">
      <header className="flex items-start justify-between gap-2">
        <RepoLink repo={card.repo} to="/ci/$" />
        {card.problems ? (
          <Tag tone="warning" dot>
            {plural(card.problems, 'problem job')}
          </Tag>
        ) : null}
      </header>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="mono text-[15px] font-semibold">{seconds(card.median)}</span>
        {change.text ? (
          <Tag tone={change.tone} mono title="Median of the last 7 days against the 7 before">
            {change.text}
          </Tag>
        ) : null}
        {card.successRate !== undefined ? (
          <span className="ml-auto text-xs text-muted">
            <span className="tabular" style={{ color: statusColor[successTone(card.successRate)] }}>
              {card.successRate}%
            </span>{' '}
            pass
          </span>
        ) : null}
      </div>
      <MiniSparkline
        values={card.weeks}
        color="var(--info)"
        label={`Median pipeline time per week of ${card.repo.path}`}
        className="h-7 w-full"
      />
      <p className="text-xs text-muted">
        {plural(card.pipelines, 'pipeline')}
        {card.ref ? (
          <>
            {' '}
            on <span className="mono">{card.ref}</span>
          </>
        ) : null}
        {card.lastRunAt ? ` · last ${formatRelative(card.lastRunAt)}` : null}
      </p>
    </article>
  )
}

/**
 * Repositories with CI runs in the last 30 days, one card each: median pipeline time on the
 * default branch, its week-over-week change, success rate and problem jobs. Scoped to the
 * viewer's team by default.
 */
export function CiPage() {
  const overview = useCiOverview()
  const repos = useRepos()
  const { view, setView, scope } = useScope()

  const groupsOf = new Map(
    (repos.data?.repos ?? []).map((summary) => [repoKey(summary.repo), summary.groups]),
  )
  const cards = (overview.data?.repos ?? []).map((card) => ({
    ...card,
    groups: groupsOf.get(repoKey(card.repo)) ?? [],
  }))
  const scoped = repos.data ? scope(cards) : undefined
  const shown = sortCiCards(scoped ? scoped.shown : cards)

  return (
    <Page
      title="CI"
      icon="ci"
      description="Pipeline time and success rate of repositories with CI runs in the last 30 days"
      actions={
        <>
          {scoped ? <ScopeSwitch value={view} onChange={setView} counts={scoped.counts} /> : null}
          <SettingsButton title="CI settings" keys={pageSettingKeys.ci} />
        </>
      }
    >
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
          {plural(scoped.others.items, 'repository', 'repositories')} of other teams run CI here.{' '}
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
          icon={<Timer />}
          title="No CI runs"
          description="The ci-jobs analyzer reads pipelines every night; repositories show up once they ran CI in the last 30 days."
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
