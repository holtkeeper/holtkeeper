import type { CoverageRepoCard } from '@holtkeeper/api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { FlaskConical } from 'lucide-react'

import { useCoverageOverview } from '../../api/queries.ts'
import { sortCoverageCards } from '../../lib/coverage.ts'
import { foldOtherTeams } from '../../lib/home-scope.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { pageSettingKeys } from '../../lib/settings-tabs.ts'
import {
  EmptyState,
  ErrorState,
  OtherTeams,
  Page,
  Placeholder,
  ScopeSwitch,
} from '../../ui/index.ts'
import { SettingsButton } from '../settings/SettingsSheet.tsx'
import { useScope } from '../shell/scope.ts'
import { CoverageCard } from './CoverageCard.tsx'
import { CoverageSheet } from './CoverageSheet.tsx'

function Grid({
  cards,
  onOpen,
}: {
  cards: readonly CoverageRepoCard[]
  onOpen: (card: CoverageRepoCard) => void
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {cards.map((card) => (
        <CoverageCard key={repoKey(card.repo)} card={card} onOpen={() => onOpen(card)} />
      ))}
    </div>
  )
}

/**
 * Test coverage of every readable repository with a coverage record, one card each, lowest line
 * coverage first; other teams' cards fold away under *My team*. A card opens its breakdown in a
 * side sheet, kept in `?repo=`.
 */
export function CoveragePage() {
  const overview = useCoverageOverview()
  const search = useSearch({ from: '/app/coverage' })
  const navigate = useNavigate({ from: '/coverage' })
  const { view, setView, homeGroups } = useScope()

  const cards = sortCoverageCards(overview.data?.repos ?? [])
  const folded = foldOtherTeams(cards, homeGroups, (card) => card.groups)
  const counts = { mine: folded.mine.length, all: cards.length, others: folded.others.length }
  const shown = view === 'mine' ? folded.mine : view === 'others' ? folded.others : cards
  const order = view === 'mine' ? [...folded.mine, ...folded.others] : shown

  const selected = parseRepoKey(search.repo)
  const index = selected ? order.findIndex((card) => repoKey(card.repo) === repoKey(selected)) : -1
  const open = (card: CoverageRepoCard | undefined) =>
    void navigate({
      search: card ? { repo: repoKey(card.repo) } : {},
      replace: true,
    })
  const previous = index > 0 ? order[index - 1] : undefined
  const next = index >= 0 ? order[index + 1] : undefined

  return (
    <Page
      title="Coverage"
      icon="coverage"
      description="Line and branch coverage of each repository's newest coverage record"
      actions={
        <>
          {overview.data ? <ScopeSwitch value={view} onChange={setView} counts={counts} /> : null}
          <SettingsButton title="Coverage settings" keys={pageSettingKeys.coverage} />
        </>
      }
    >
      {overview.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Placeholder key={i} className="h-44" />
          ))}
        </div>
      ) : overview.isError ? (
        <ErrorState error={overview.error} />
      ) : cards.length === 0 ? (
        <EmptyState
          icon={<FlaskConical />}
          title="No coverage recorded"
          description="Repositories show up once the coverage analyzer has run on them."
        />
      ) : (
        <>
          {shown.length ? (
            <Grid cards={shown} onOpen={open} />
          ) : (
            <p className="text-sm text-muted">No repositories in this scope.</p>
          )}
          {view === 'mine' ? (
            <OtherTeams count={folded.others.length} teams={folded.teams}>
              <Grid cards={folded.others} onOpen={open} />
            </OtherTeams>
          ) : null}
        </>
      )}
      <CoverageSheet
        repo={selected}
        onClose={() => open(undefined)}
        {...(index >= 0 ? { index, total: order.length } : {})}
        {...(previous ? { onPrevious: () => open(previous) } : {})}
        {...(next ? { onNext: () => open(next) } : {})}
      />
    </Page>
  )
}
