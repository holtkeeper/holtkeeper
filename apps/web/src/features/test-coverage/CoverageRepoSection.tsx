import type { RepoRef } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import { useRepoCoverage, useSettings } from '../../api/queries.ts'
import { orgCoverageTarget, trendValues } from '../../lib/coverage.ts'
import { repoKey } from '../../lib/repo.ts'
import { EmptyState, ErrorState, LinkButton, Placeholder, UnderlineTabs } from '../../ui/index.ts'
import { MiniSparkline } from '../../ui/MiniSparkline.tsx'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import {
  type CoverageTab,
  CoverageHeadline,
  CoverageTabBody,
  coverageTabItems,
  coverageTabOf,
  useCoverageOptions,
} from './CoverageSheet.tsx'

/**
 * The hub's Quality › Coverage area for one repository: freshness, shares and change against its
 * target over the coverage bar and trend, then the Breakdown, Files, Changes and Exclusions tabs
 * the Coverage sheet has. Offers Run coverage until a record exists.
 */
export function CoverageRepoSection({ repo }: { repo: RepoRef }) {
  const coverage = useRepoCoverage(repo)
  const settings = useSettings()
  const options = useCoverageOptions(repo, orgCoverageTarget(settings.data))
  const [tab, setTab] = useState<CoverageTab>('breakdown')
  if (coverage.isPending) return <Placeholder className="h-48" />
  if (coverage.isError) return <ErrorState error={coverage.error} />
  const data = coverage.data
  const card = data.card
  if (!card)
    return (
      <EmptyState
        title="Not measured yet"
        description="The coverage analyzer has not stored a record for this repository."
        action={<RunJobButton repo={repo} analyzer="coverage" label="Run coverage" />}
      />
    )
  return (
    <section className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold">Test coverage</h2>
          <div className="flex items-center gap-2">
            <LinkButton
              to="/quality/coverage"
              search={{ repo: repoKey(repo) }}
              variant="ghost"
              size="sm"
            >
              Open in Quality
            </LinkButton>
            <Link
              to="/analyses/$id"
              params={{ id: card.analysisId }}
              search={{}}
              className="text-xs text-muted hover:text-foreground"
            >
              Full record
            </Link>
            <RunJobButton
              repo={repo}
              analyzer="coverage"
              label="Run coverage"
              variant="secondary"
              size="sm"
            />
          </div>
        </div>
        <CoverageHeadline card={card} target={options.target} />
        {card.trend.length > 1 ? (
          <MiniSparkline
            values={trendValues(card)}
            color="var(--info)"
            label={`Line coverage of the last ${card.trend.length} records`}
            className="h-8 w-full"
          />
        ) : null}
      </div>
      <UnderlineTabs
        aria-label="Coverage sections"
        items={coverageTabItems(data, options.excludes?.length)}
        selected={tab}
        onSelect={(id) => setTab(coverageTabOf(id))}
        className="border-t"
      />
      <div className="px-4 py-3.5">
        <CoverageTabBody repo={repo} data={data} tab={tab} options={options} />
      </div>
    </section>
  )
}
