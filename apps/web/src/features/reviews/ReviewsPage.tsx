import type { RepoRef, ReviewRow } from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ExternalLink, GitPullRequestArrow, MessageSquareCode, X } from 'lucide-react'
import { useState } from 'react'

import { useRepos, useReviews } from '../../api/queries.ts'
import { formatUsd } from '../../lib/ai-usage.ts'
import { neighbours } from '../../lib/flow.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { foldScope } from '../../lib/home-scope.ts'
import { parseRepoKey, repoKey, repoSplat } from '../../lib/repo.ts'
import {
  type ReviewSortKey,
  type ReviewsSearch,
  filterReviews,
  modeLabel,
  parseReviewsSearch,
  reviewAuthors,
  reviewModes,
  reviewPeriods,
  reviewSince,
  type ReviewTotals,
  reviewTotals,
  reviewVerdicts,
  severitySegments,
  severityText,
  sortReviews,
  verdictLabel,
  verdictTone,
} from '../../lib/reviews.ts'
import { patchSearch } from '../../lib/search-params.ts'
import { pageSettingKeys } from '../../lib/settings-sections.ts'
import type { SortState } from '../../lib/table-sort.ts'
import {
  Button,
  Dot,
  EmptyState,
  ErrorState,
  type FleetColumn,
  FilterButton,
  FleetTable,
  LoadMore,
  Page,
  Placeholder,
  SegmentBar,
  type StripCell,
  buttonClass,
} from '../../ui/index.ts'
import { useConfigure } from '../settings/SettingsSheet.tsx'
import { useScope } from '../shell/scope.ts'
import { ReviewMergeRequestDialog, useCanReview } from './ReviewDialogs.tsx'
import { ReviewReactions } from './ReviewReactions.tsx'
import { ReviewSheet } from './ReviewSheet.tsx'

interface Row {
  review: ReviewRow
  groups: readonly string[]
}

const columns = (narrowed: boolean): FleetColumn<Row, ReviewSortKey>[] => [
  {
    id: 'mr',
    header: 'Merge request',
    className: 'min-w-64 max-w-[340px]',
    cell: ({ review }) => (
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate" title={review.mergeRequest.title}>
          <span className="mono text-muted">!{review.mergeRequest.iid}</span>{' '}
          {review.mergeRequest.title}
        </span>
        <span className="mt-0.5 text-[11.5px] text-dim">
          {[review.mergeRequest.author, review.mode === 'full' ? undefined : modeLabel[review.mode]]
            .filter(Boolean)
            .join(' · ') || modeLabel[review.mode]}
        </span>
      </span>
    ),
  },
  ...(narrowed
    ? []
    : [
        {
          id: 'repo',
          header: 'Repository',
          cell: ({ review }: Row) => (
            <Link
              to="/repos/$"
              params={{ _splat: repoSplat(review.repo) }}
              search={{ tab: 'quality', section: 'reviews' }}
              className="mono text-[12px] text-muted hover:text-foreground hover:underline"
            >
              {review.repo.path}
            </Link>
          ),
        },
      ]),
  {
    id: 'verdict',
    header: 'Verdict',
    cell: ({ review }) => (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <Dot tone={verdictTone[review.verdict]} />
        {verdictLabel[review.verdict]}
      </span>
    ),
  },
  {
    id: 'findings',
    header: 'Findings',
    sortKey: 'findings',
    align: 'right',
    cell: ({ review }) => (
      <span
        className="inline-flex items-center justify-end gap-2"
        title={severityText(review.severities) || 'No findings'}
      >
        {review.findings ? (
          <SegmentBar segments={severitySegments(review.severities)} className="w-14" />
        ) : null}
        <span className={`mono ${review.findings ? '' : 'text-dim'}`}>{review.findings}</span>
      </span>
    ),
  },
  {
    id: 'resolved',
    header: 'Resolved',
    align: 'right',
    cell: ({ review }) => (
      <span className={`mono ${review.resolved ? '' : 'text-dim'}`}>{review.resolved}</span>
    ),
  },
  {
    id: 'cost',
    header: 'Cost',
    sortKey: 'cost',
    align: 'right',
    cell: ({ review }) => (
      <span className="mono text-muted">
        {review.costUsd === undefined ? '—' : formatUsd(review.costUsd)}
      </span>
    ),
  },
  {
    id: 'when',
    header: 'When',
    sortKey: 'when',
    cell: ({ review }) => (
      <span className="whitespace-nowrap text-muted" title={formatDateTime(review.createdAt)}>
        {formatRelative(review.createdAt)}
      </span>
    ),
  },
  {
    id: 'forge',
    header: <span className="sr-only">Merge request on the forge</span>,
    align: 'right',
    cell: ({ review }) => (
      <a
        href={review.mergeRequest.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open !${review.mergeRequest.iid} on the forge`}
        className={buttonClass('ghost', 'sm', 'w-7 min-w-7 px-0')}
      >
        <ExternalLink className="size-3.5" />
      </a>
    ),
  },
]

const stripCells = (totals: ReviewTotals, note?: string): StripCell[] => {
  return [
    {
      value: totals.reviews,
      label: totals.reviews === 1 ? 'review' : 'reviews',
      ...(note ? { caption: note } : {}),
    },
    ...reviewVerdicts.map((verdict) => ({
      value: totals.verdicts[verdict],
      label: verdictLabel[verdict].toLowerCase(),
      tone: verdict === 'skipped' ? ('none' as const) : verdictTone[verdict],
    })),
    {
      prefix: 'Findings',
      value: totals.findings,
      label: 'posted',
      ...(severityText(totals.severities)
        ? { caption: `· ${severityText(totals.severities)}` }
        : {}),
    },
    { value: totals.resolved, label: 'threads resolved' },
    {
      prefix: 'AI cost',
      value: <span className="mono">{formatUsd(totals.costUsd)}</span>,
      label: '',
      end: true,
    },
  ]
}

const verdictOptions = reviewVerdicts.map((id) => ({ id, label: verdictLabel[id] }))
const modeOptions = reviewModes.map((id) => ({ id, label: modeLabel[id] }))
const periodOptions = reviewPeriods.map((days) => ({
  id: String(days),
  label: `Last ${days} days`,
}))

/**
 * The reviews table with its filters and sheet: every readable repository with the scope switch,
 * or one repository (`repo`) without the repository column. `search` holds filters and the open
 * run; `update` patches it.
 */
export function ReviewsBody({
  repo,
  search,
  update,
}: {
  repo?: RepoRef
  search: ReviewsSearch
  update: (patch: Partial<ReviewsSearch>) => void
}) {
  const { view, setView, homeGroups } = useScope()
  const [sort, setSort] = useState<SortState<ReviewSortKey>>(null)
  const since = reviewSince(search.days)
  const reviews = useReviews({
    ...(repo ? { repo: repoKey(repo) } : {}),
    ...(search.verdict ? { verdict: search.verdict } : {}),
    ...(since ? { since } : {}),
  })
  const repos = useRepos()
  const groupsOf = new Map(
    (repos.data?.repos ?? []).map((summary) => [repoKey(summary.repo), summary.groups]),
  )

  if (reviews.isPending) return <Placeholder className="h-72" />
  if (reviews.isError) return <ErrorState error={reviews.error} />

  const loaded = reviews.data.pages.flatMap((page) => page.reviews)
  const rows: Row[] = sortReviews(filterReviews(loaded, search), sort).map((review) => ({
    review,
    groups: groupsOf.get(repoKey(review.repo)) ?? [],
  }))
  const folded = foldScope(rows, view, homeGroups, (row) => row.groups)
  const keys = (repo ? rows : [...folded.shown, ...folded.others]).map(
    (row) => row.review.analysisId,
  )
  const step = neighbours(keys, search.review)
  const current = rows.find((row) => row.review.analysisId === search.review)?.review
  const authors = reviewAuthors(loaded)
  const filtered = Boolean(search.q || search.verdict || search.mode || search.author)
  const window = reviews.data.pages[0]?.window
  const narrowedHere = Boolean(
    search.q || search.mode || search.author || (!repo && view !== 'all'),
  )
  const strip = (shown: readonly Row[]) =>
    window && !narrowedHere
      ? stripCells(window, window.partial ? '· at least' : undefined)
      : stripCells(
          reviewTotals(shown.map((row) => row.review)),
          reviews.hasNextPage ? '· of the loaded ones' : undefined,
        )

  return (
    <div className="flex flex-col gap-3">
      <FleetTable<Row, ReviewSortKey>
        label="Reviews"
        rows={rows}
        rowKey={(row) => row.review.analysisId}
        columns={columns(repo !== undefined)}
        sort={sort}
        onSort={setSort}
        {...(repo ? {} : { scope: { value: view, onChange: setView, homeGroups } })}
        strip={strip}
        noun={{ one: 'review', many: 'reviews' }}
        onOpen={(row) => update({ review: row.review.analysisId })}
        toolbar={
          <>
            <FilterButton
              label="Verdict"
              options={verdictOptions}
              value={search.verdict ? [search.verdict] : []}
              onChange={(ids) =>
                update({ verdict: parseReviewsSearch({ verdict: ids.at(-1) }).verdict })
              }
            />
            {authors.length ? (
              <FilterButton
                label="Author"
                all="Anyone"
                options={authors.map((author) => ({ id: author, label: author }))}
                value={search.author ? [search.author] : []}
                onChange={(ids) => update({ author: ids.at(-1) })}
              />
            ) : null}
            <FilterButton
              label="Mode"
              options={modeOptions}
              value={search.mode ? [search.mode] : []}
              onChange={(ids) => update({ mode: parseReviewsSearch({ mode: ids.at(-1) }).mode })}
            />
            <FilterButton
              label="Period"
              all="Last 30 days"
              options={periodOptions}
              value={search.days && search.days !== 30 ? [String(search.days)] : []}
              onChange={(ids) => {
                const days = parseReviewsSearch({ days: ids.at(-1) }).days
                update({ days: days === 30 ? undefined : days })
              }}
            />
          </>
        }
        empty={
          <EmptyState
            icon={<MessageSquareCode />}
            title={filtered ? 'No reviews match' : 'No reviews yet'}
            description={
              filtered
                ? 'Change or clear the filters to see more reviews.'
                : repo
                  ? "Holtkeeper's merge request reviews of this repository show up here."
                  : "Holtkeeper's merge request reviews of every repository you can read show up here."
            }
          />
        }
      />
      {reviews.hasNextPage ? (
        <LoadMore
          onLoad={() => void reviews.fetchNextPage()}
          isPending={reviews.isFetchingNextPage}
          size="sm"
          className="self-center"
        >
          Show older reviews
        </LoadMore>
      ) : null}
      <ReviewReactions {...(repo ? { repo } : {})} />
      <ReviewSheet
        row={current}
        tab={search.tab}
        onTab={(tab) => update({ tab: tab === 'findings' ? undefined : tab })}
        onClose={() => update({ review: undefined, tab: undefined })}
        {...(current && step.index >= 0 ? { index: step.index, total: keys.length } : {})}
        {...(step.previous ? { onPrevious: () => update({ review: step.previous }) } : {})}
        {...(step.next ? { onNext: () => update({ review: step.next }) } : {})}
      />
    </div>
  )
}

/** Quality › Reviews: Holtkeeper's merge request reviews of every readable repository. */
export function ReviewsPage() {
  const search = useSearch({ from: '/app/quality/reviews' })
  const navigate = useNavigate({ from: '/quality/reviews' })
  const repo = parseRepoKey(search.repo)
  const canReview = useCanReview()
  const [asking, setAsking] = useState(false)
  const settings = useConfigure('Review settings', pageSettingKeys.reviews)
  const update = (patch: Partial<ReviewsSearch>) =>
    void navigate({
      search: (prev) => patchSearch(prev, patch),
      replace: true,
    })

  return (
    <Page
      crumbs={[{ label: 'Reviews' }]}
      description={
        repo
          ? `Holtkeeper's merge request reviews of ${repoKey(repo)}`
          : "Holtkeeper's merge request reviews of every repository you can see"
      }
      search={{
        value: search.q ?? '',
        onChange: (q) => update({ q: q || undefined }),
        'aria-label': 'Filter reviews',
        placeholder: 'Filter by merge request, repository',
      }}
      {...(repo
        ? {
            filters: (
              <Button size="sm" variant="secondary" onPress={() => update({ repo: undefined })}>
                Repository: <span className="mono">{repo.path}</span>
                <X aria-label="Clear repository" className="size-3.5" />
              </Button>
            ),
          }
        : {})}
      configure={settings.configure}
      {...(canReview
        ? {
            primary: {
              label: 'Review a merge request',
              icon: GitPullRequestArrow,
              onPress: () => setAsking(true),
            },
          }
        : {})}
    >
      <ReviewsBody {...(repo ? { repo } : {})} search={search} update={update} />
      <ReviewMergeRequestDialog
        isOpen={asking}
        onOpenChange={setAsking}
        {...(repo ? { repo } : {})}
      />
      {settings.sheet}
    </Page>
  )
}
