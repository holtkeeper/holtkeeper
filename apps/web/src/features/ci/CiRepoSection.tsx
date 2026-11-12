import type { RepoRef } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import { useCiOverview, useCiRepo } from '../../api/queries.ts'
import { outcomeBar } from '../../lib/ci.ts'
import { repoKey } from '../../lib/repo.ts'
import { ErrorState, LinkButton, Placeholder, SegmentBar, UnderlineTabs } from '../../ui/index.ts'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { type CiTab, CiSummary, CiTabBody, ciTabItems, ciTabOf } from './CiSheet.tsx'

/**
 * The hub's Quality › CI area for one repository: its state and pipeline outcomes, then the
 * Overview, Jobs, Problems and Reliability tabs the CI sheet has, with Re-read pipelines.
 */
export function CiRepoSection({ repo }: { repo: RepoRef }) {
  const view = useCiRepo(repo)
  const overview = useCiOverview()
  const [tab, setTab] = useState<CiTab>('overview')
  if (view.isPending) return <Placeholder className="h-48" />
  if (view.isError) return <ErrorState error={view.error} />
  const card = overview.data?.repos.find((entry) => repoKey(entry.repo) === repoKey(repo))
  const bar = outcomeBar(view.data.data?.pipelines.outcomes)
  return (
    <section className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold">CI</h2>
          <div className="flex items-center gap-2">
            <LinkButton to="/quality/ci" search={{ repo: repoKey(repo) }} variant="ghost" size="sm">
              Open in Quality
            </LinkButton>
            {view.data.analysisId ? (
              <Link
                to="/analyses/$id"
                params={{ id: view.data.analysisId }}
                search={{}}
                className="text-xs text-muted hover:text-foreground"
              >
                Full record
              </Link>
            ) : null}
            {view.data.data ? (
              <RunJobButton
                repo={repo}
                analyzer="ci-jobs"
                label="Re-read pipelines"
                variant="secondary"
                size="sm"
              />
            ) : null}
          </div>
        </div>
        <CiSummary view={view.data} card={card} />
        {bar ? (
          <div className="flex flex-col gap-1">
            <SegmentBar segments={bar.segments} />
            <span className="text-[11px] text-muted">{bar.label}</span>
          </div>
        ) : null}
      </div>
      {view.data.data ? (
        <UnderlineTabs
          aria-label="CI sections"
          items={ciTabItems(view.data)}
          selected={tab}
          onSelect={(id) => setTab(ciTabOf(id))}
          className="border-t"
        />
      ) : null}
      <div className="px-4 py-3.5">
        <CiTabBody repo={repo} view={view.data} card={card} tab={tab} onTab={setTab} />
      </div>
    </section>
  )
}
