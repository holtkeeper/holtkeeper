import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'

import { useAnalyses, useAnalysis } from '../../api/queries.ts'
import { analysisPages, groupAnalysisPages } from '../../lib/analyses.ts'
import { formatDate } from '../../lib/format.ts'
import { repoKey } from '../../lib/repo.ts'
import { ErrorState, Page, Placeholder, Select } from '../../ui/index.ts'
import { ReportContext } from '../reports/context.ts'
import { ReportView } from '../reports/ReportView.tsx'
import { useSession } from '../shell/session.ts'

const previous = '__previous'

/** One analysis record rendered as a report, with a picker for what to compare it against. */
export function AnalysisPage() {
  const { id } = useParams({ from: '/app/analyses/$id' })
  const { can } = useSession()
  const { compare } = useSearch({ from: '/app/analyses/$id' })
  const navigate = useNavigate({ from: '/analyses/$id' })
  const detail = useAnalysis(id, compare)
  const analysis = detail.data?.analysis
  const siblings = useAnalyses(analysis?.kind ?? '', analysis?.repo, 200, analysis !== undefined)

  if (detail.isPending) {
    return (
      <Page title="Report">
        <Placeholder className="h-32" />
        <Placeholder className="h-96" />
      </Page>
    )
  }
  if (detail.isError)
    return (
      <Page title="Report">
        <ErrorState error={detail.error} />
      </Page>
    )

  const { report } = detail.data
  const page = [...analysisPages, ...groupAnalysisPages].find(
    (p) => p.kind === detail.data.analysis.kind,
  )
  const others = (siblings.data?.analyses ?? []).filter((a) => a.id !== id)
  const key = repoKey(detail.data.analysis.repo)

  return (
    <Page
      eyebrow={
        page ? (
          <Link
            to={page.to}
            search={{ repo: key }}
            className="inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus"
          >
            <ArrowLeft className="size-3.5" />
            {page.title} of {key}
          </Link>
        ) : (
          key
        )
      }
      title={detail.data.analysis.label}
      description={
        detail.data.previous && !compare
          ? `Compared with the previous record, ${detail.data.previous.label}`
          : undefined
      }
      actions={
        <Select
          aria-label="Compare with"
          className="w-72"
          options={[
            {
              id: previous,
              label: detail.data.previous
                ? `Previous (${detail.data.previous.label})`
                : 'Previous record',
            },
            ...others.map((a) => ({
              id: a.id,
              label: `${a.label} · ${formatDate(a.createdAt)}`,
              text: a.label,
            })),
          ]}
          value={compare ?? previous}
          onChange={(value) =>
            void navigate({ search: value === previous ? {} : { compare: value } })
          }
        />
      }
    >
      <div
        className={
          detail.isPlaceholderData ? 'opacity-60 transition-opacity' : 'transition-opacity'
        }
      >
        <ReportContext value={{ analysisId: id, canApply: can('analyses:run') }}>
          <ReportView report={report} />
        </ReportContext>
      </div>
    </Page>
  )
}
