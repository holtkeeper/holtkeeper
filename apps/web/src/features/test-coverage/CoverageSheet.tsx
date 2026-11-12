import type { CoverageRepoCard, RepoCoverageView, RepoRef } from '@holtkeeper/api'
import { useRouter } from '@tanstack/react-router'
import { FolderGit2, Play, Plus, X } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useDescribeScope,
  useRepoCoverage,
  useResolvedSettings,
  useSettingMutations,
} from '../../api/queries.ts'
import {
  coverageExcludes,
  coverageFreshness,
  coverageFreshnessLabel,
  coverageFreshnessTone,
  coverageSetting,
  coverageTone,
  formatPercent,
  formatPoints,
  lineSegments,
  percentOf,
  pointsTone,
  resolvedCoverageTarget,
} from '../../lib/coverage.ts'
import { unexcludeEntry } from '../../lib/exclude.ts'
import { formatDateTime, formatRelative, plural, shortSha } from '../../lib/format.ts'
import { jobStatusLabel, jobStatusTone, jobTriggerLabel } from '../../lib/jobs.ts'
import { repoSplat } from '../../lib/repo.ts'
import { statusColor } from '../../ui/colors.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  KeyValue,
  Placeholder,
  SegmentBar,
  SideSheet,
  Table,
  Tag,
  Td,
  Th,
  notify,
} from '../../ui/index.ts'
import { RunJobButton, useRunJob } from '../jobs/RunJobDialog.tsx'
import { ExcludeDialog } from '../reports/ExcludeDialog.tsx'
import { useSession } from '../shell/session.ts'
import { NoTestsNotice, useTestsToggle } from './TestsToggle.tsx'

interface Counts {
  covered: number
  total: number
}

const coverageExclude = (defaults: string[]) => ({
  setting: coverageSetting,
  options: [
    {
      option: 'exclude',
      label: 'Leave out',
      description: 'Files matching the glob are not measured from the next run.',
      defaults,
    },
  ],
})

function Share({ counts }: { counts: Counts | undefined }) {
  const value = percentOf(counts)
  return (
    <span className="mono tabular" style={{ color: statusColor[coverageTone(value)] }}>
      {formatPercent(value)}
    </span>
  )
}

/** Tabs of a coverage breakdown, in order. */
export type CoverageTab = 'breakdown' | 'files' | 'changes' | 'exclusions'

/** `id` as a coverage tab; unknown ids fall back to Breakdown. */
export const coverageTabOf = (id: string): CoverageTab =>
  id === 'files' || id === 'changes' || id === 'exclusions' ? id : 'breakdown'

/** The tab bar entries of a coverage breakdown with their counts. */
export const coverageTabItems = (data: RepoCoverageView, exclusions: number | undefined) => [
  { id: 'breakdown', label: 'Breakdown' },
  { id: 'files', label: 'Files', badge: data.card?.totals.files ?? data.worst.length },
  { id: 'changes', label: 'Changes', badge: data.changes.length },
  {
    id: 'exclusions',
    label: 'Exclusions',
    ...(exclusions === undefined ? {} : { badge: exclusions }),
  },
]

/**
 * The coverage target of `repo` and its exclude globs, from the resolved `analyzers.coverage`
 * value; `fallback` until it loads or when it sets no target.
 */
export function useCoverageOptions(repo: RepoRef | undefined, fallback: number) {
  const resolved = useResolvedSettings(repo)
  const entry = resolved.data?.settings[coverageSetting]
  return {
    resolved,
    entry,
    target: resolvedCoverageTarget(entry?.value, fallback),
    excludes: resolved.data ? coverageExcludes(entry?.value) : undefined,
  }
}

/**
 * Line, branch and function shares of a record with its change and the target, over its bar;
 * with `noTests` (no tests by design) the target is not judged.
 */
export function CoverageHeadline({
  card,
  target,
  noTests,
}: {
  card: CoverageRepoCard
  target: number
  noTests?: boolean
}) {
  const { totals } = card
  const lines = percentOf(totals.lines)
  const freshness = coverageFreshness({ repo: card.repo, groups: card.groups, card })
  const change = formatPoints(card.change)
  const segments = lineSegments(totals)
  const total = totals.lines.total
  const share = (value: number) => (total ? `${Math.round((value / total) * 1000) / 10}%` : '—')
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <Tag tone={coverageFreshnessTone[freshness]} dot>
          {coverageFreshnessLabel[freshness]}
        </Tag>
        <span>
          Lines <Share counts={totals.lines} />
        </span>
        {totals.branches ? (
          <span>
            Branches <Share counts={totals.branches} />
          </span>
        ) : null}
        {totals.functions ? (
          <span>
            Functions <Share counts={totals.functions} />
          </span>
        ) : null}
        {change ? (
          <Tag tone={pointsTone(card.change)} mono title="Since the previous record">
            {change}
          </Tag>
        ) : null}
        {!noTests && lines !== undefined && lines < target ? (
          <Tag tone="warning">Below {formatPercent(target)} target</Tag>
        ) : null}
      </div>
      <SegmentBar segments={segments} />
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
        {segments.map((segment) => (
          <span key={segment.label} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-sm"
              style={{ background: statusColor[segment.tone] }}
            />
            {segment.label === 'lines in files without tests'
              ? 'No tests'
              : segment.label === 'covered lines'
                ? 'Covered'
                : 'Uncovered'}{' '}
            <span className="tabular text-foreground">{share(segment.value)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function RecordFacts({
  card,
  job,
  target,
}: {
  card: CoverageRepoCard
  job: RepoCoverageView['job']
  target: number
}) {
  const changed = card.changed ? percentOf(card.changed.lines) : undefined
  return (
    <KeyValue
      rows={[
        {
          label: 'Measured',
          value: (
            <span title={formatDateTime(card.createdAt)}>
              {card.sha ? <span className="mono">{shortSha(card.sha)}</span> : null}{' '}
              {formatRelative(card.createdAt)}
              {card.head ? (
                <span className="text-muted">
                  {' '}
                  · HEAD is <span className="mono">{shortSha(card.head)}</span>
                </span>
              ) : null}
            </span>
          ),
        },
        {
          label: 'Tools',
          value: card.tools.length ? (
            <span className="flex flex-wrap gap-1">
              {card.tools.map((tool) => (
                <Tag key={tool} mono>
                  {tool}
                </Tag>
              ))}
            </span>
          ) : (
            <span className="text-muted">Unknown</span>
          ),
        },
        {
          label: 'Changed files',
          value: card.changed ? (
            <span>
              <span className="tabular" style={{ color: statusColor[coverageTone(changed)] }}>
                {formatPercent(changed)}
              </span>{' '}
              <span className="text-muted">
                of lines in {plural(card.changed.files, 'file')} since the previous record
              </span>
            </span>
          ) : null,
        },
        {
          label: 'Files',
          value: (
            <span>
              <span className="tabular">{card.totals.files}</span>
              {card.totals.untested ? (
                <span className="text-muted"> · {card.totals.untested} without tests</span>
              ) : null}
            </span>
          ),
        },
        { label: 'Target', value: <span className="mono">{formatPercent(target)} lines</span> },
        {
          label: 'Trigger',
          value: job ? (
            <span className="flex flex-wrap items-center gap-1.5">
              {jobTriggerLabel(job.trigger)}
              <Tag tone={jobStatusTone(job.status)} dot>
                {jobStatusLabel(job.status)}
              </Tag>
            </span>
          ) : (
            <span className="text-muted">Upload or pruned job</span>
          ),
        },
        {
          label: 'Last run',
          value: job ? (
            <span title={formatDateTime(job.finishedAt ?? job.createdAt)}>
              {formatRelative(job.finishedAt ?? job.createdAt)}
            </span>
          ) : null,
        },
      ]}
    />
  )
}

function Breakdown({ data, target }: { data: RepoCoverageView; target: number }) {
  const card = data.card
  if (!card) return null
  const groups = data.groups.toSorted(
    (a, b) => (percentOf(a.lines) ?? 101) - (percentOf(b.lines) ?? 101),
  )
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold text-muted">Record</h3>
        <RecordFacts card={card} job={data.job} target={target} />
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold text-muted">
          By package or folder <span className="font-normal text-dim">· lowest first</span>
        </h3>
        {groups.length ? (
          <Table label="Coverage by package or folder">
            <thead>
              <tr>
                <Th>Path</Th>
                <Th className="w-28">Lines</Th>
                <Th align="right">Branches</Th>
                <Th align="right">Files</Th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.path}>
                  <Td className="mono text-xs">{group.path}</Td>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <Share counts={group.lines} />
                      <SegmentBar
                        segments={[
                          { value: group.lines.covered, tone: 'success', label: 'covered lines' },
                          {
                            value: group.lines.total - group.lines.covered,
                            tone: coverageTone(percentOf(group.lines)),
                            label: 'uncovered lines',
                          },
                        ]}
                      />
                    </div>
                  </Td>
                  <Td align="right">
                    <Share counts={group.branches} />
                  </Td>
                  <Td align="right" className="tabular">
                    {group.files}
                    {group.untested ? (
                      <span className="text-muted"> ({group.untested} untested)</span>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="text-sm text-muted">The record has no packages or folders.</p>
        )}
      </section>
    </div>
  )
}

const splitFile = (file: string) => {
  const at = file.lastIndexOf('/')
  return at < 0 ? { name: file, dir: '' } : { name: file.slice(at + 1), dir: file.slice(0, at) }
}

function Files({
  data,
  onExclude,
}: {
  data: RepoCoverageView
  onExclude: ((file: string) => void) | undefined
}) {
  if (!data.worst.length) return <p className="text-sm text-muted">Every file is covered.</p>
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-muted">
        Least covered files <span className="font-normal text-dim">· by uncovered lines</span>
      </h3>
      <Table label="Files with the most uncovered lines">
        <thead>
          <tr>
            <Th>File</Th>
            <Th align="right">Uncovered</Th>
            <Th align="right">Lines</Th>
            {onExclude ? (
              <Th align="right">
                <span className="sr-only">Exclude</span>
              </Th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {data.worst.map((file) => {
            const { name, dir } = splitFile(file.file)
            return (
              <tr key={file.file}>
                <Td>
                  <div className="flex min-w-0 flex-col leading-tight" title={file.file}>
                    <span className="mono truncate text-xs">
                      {name}
                      {file.loaded === false ? (
                        <Tag tone="danger" className="ml-2">
                          No tests
                        </Tag>
                      ) : null}
                    </span>
                    {dir ? <span className="mono truncate text-[11px] text-dim">{dir}</span> : null}
                  </div>
                </Td>
                <Td align="right" className="tabular">
                  {file.lines.total - file.lines.covered}
                </Td>
                <Td align="right">
                  <Share counts={file.lines} />
                </Td>
                {onExclude ? (
                  <Td align="right">
                    <Button variant="ghost" size="sm" onPress={() => onExclude(file.file)}>
                      Exclude
                    </Button>
                  </Td>
                ) : null}
              </tr>
            )
          })}
        </tbody>
      </Table>
    </section>
  )
}

function Changes({ data }: { data: RepoCoverageView }) {
  if (!data.changes.length)
    return <p className="text-sm text-muted">No file moved since the previous record.</p>
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-muted">Moved since the previous record</h3>
      <ul className="flex flex-col gap-1 text-xs">
        {data.changes.map((change) => (
          <li key={change.file} className="flex items-center justify-between gap-2">
            <span className="mono min-w-0 truncate" title={change.file}>
              {change.file}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="tabular text-muted">
                {change.before === undefined ? 'new' : formatPercent(change.before)} →{' '}
                {formatPercent(change.after)}
              </span>
              <Tag tone={pointsTone(change.delta)} mono>
                {formatPoints(change.delta) || '0 pt'}
              </Tag>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Exclusions({
  repo,
  options,
  canWrite,
  onAdd,
}: {
  repo: RepoRef
  options: ReturnType<typeof useCoverageOptions>
  canWrite: boolean
  onAdd: () => void
}) {
  const { put } = useSettingMutations()
  const describeScope = useDescribeScope()
  const { resolved, entry, excludes } = options
  if (resolved.isPending) return <Placeholder className="h-24" />
  if (resolved.isError) return <ErrorState error={resolved.error} />
  const remove = (pattern: string) =>
    put.mutate(unexcludeEntry(coverageSetting, 'exclude', pattern, repo, entry, excludes ?? []), {
      onSuccess: () => notify.success(`Removed ${pattern}`, 'Applies from the next run'),
      onError: (error) => notify.error('Could not remove the pattern', messageOf(error)),
    })
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          Globs in <span className="mono">{coverageSetting}</span> →{' '}
          <span className="mono">exclude</span>
          {entry ? <> · set for {describeScope(entry.scope)}</> : null}
        </p>
        {canWrite ? (
          <Button variant="secondary" size="sm" onPress={onAdd}>
            <Plus className="size-3.5" />
            Add pattern
          </Button>
        ) : null}
      </div>
      {excludes?.length ? (
        <ul className="flex flex-col divide-y divide-[var(--line)] rounded-[7px] border border-line">
          {excludes.map((pattern) => (
            <li key={pattern} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span className="mono min-w-0 truncate text-xs" title={pattern}>
                {pattern}
              </span>
              {canWrite ? (
                <Button
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  aria-label={`Remove ${pattern}`}
                  isDisabled={put.isPending}
                  onPress={() => remove(pattern)}
                >
                  <X className="size-3.5" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No file is left out; every source file is measured.</p>
      )}
    </section>
  )
}

/**
 * The body of one coverage tab for `repo`: Breakdown (record facts, trigger and the table per
 * package or folder), Files (least covered files, each with Exclude), Changes (files that moved
 * since the previous record) or Exclusions (the exclude globs, added through `ExcludeDialog` and
 * removed in place for callers who may write settings).
 */
export function CoverageTabBody({
  repo,
  data,
  tab,
  options,
}: {
  repo: RepoRef
  data: RepoCoverageView
  tab: CoverageTab
  options: ReturnType<typeof useCoverageOptions>
}) {
  const { can } = useSession()
  const canWrite = can('settings:write')
  const [excluding, setExcluding] = useState<{ path?: string }>()
  return (
    <>
      {tab === 'breakdown' ? <Breakdown data={data} target={options.target} /> : null}
      {tab === 'files' ? (
        <Files data={data} onExclude={canWrite ? (path) => setExcluding({ path }) : undefined} />
      ) : null}
      {tab === 'changes' ? <Changes data={data} /> : null}
      {tab === 'exclusions' ? (
        <Exclusions
          repo={repo}
          options={options}
          canWrite={canWrite}
          onAdd={() => setExcluding({})}
        />
      ) : null}
      {excluding ? (
        <ExcludeDialog
          repo={repo}
          exclude={coverageExclude(options.excludes ?? [])}
          {...(excluding.path ? { path: excluding.path } : {})}
          onClose={() => setExcluding(undefined)}
        />
      ) : null}
    </>
  )
}

/**
 * "Not measured yet" with Run coverage, and "Mark as no tests by design…" for callers who may
 * change `repo.tests`.
 */
export function NotMeasured({
  repo,
  tests,
}: {
  repo: RepoRef
  tests: ReturnType<typeof useTestsToggle>
}) {
  return (
    <EmptyState
      title="Not measured yet"
      description="The coverage analyzer has not stored a record for this repository."
      action={
        <span className="flex flex-wrap items-center justify-center gap-2">
          <RunJobButton repo={repo} analyzer="coverage" label="Run coverage" />
          {tests.toggle?.kind === 'mark' ? (
            <Button variant="tertiary" onPress={tests.openMark}>
              Mark as no tests by design…
            </Button>
          ) : null}
        </span>
      }
    />
  )
}

/**
 * One repository's coverage in a side sheet: freshness, shares and change against the target over
 * the covered / uncovered / untested bar, then Breakdown, Files, Changes and Exclusions tabs, with
 * Run coverage. A repository with no tests by design (`repo.tests`) shows that notice instead of
 * Run coverage, with any stored record below it. `target` is the fallback until the repository's
 * own target loads. Closed while `repo` is unset.
 */
export function CoverageSheet({
  repo,
  target: fallback,
  onClose,
  index,
  total,
  onPrevious,
  onNext,
}: {
  repo: RepoRef | undefined
  target: number
  onClose: () => void
  index?: number
  total?: number
  onPrevious?: () => void
  onNext?: () => void
}) {
  const router = useRouter()
  const coverage = useRepoCoverage(repo)
  const options = useCoverageOptions(repo, fallback)
  const run = useRunJob({ repo, analyzer: 'coverage', label: 'Run coverage' })
  const [tab, setTab] = useState<CoverageTab>('breakdown')
  const data = coverage.data
  const card = data?.card
  const tests = useTestsToggle(repo, data?.tests)
  const noTests = data?.tests?.expected === false ? data.tests : undefined
  const runAction =
    run.action?.onPress && !noTests
      ? { label: 'Run coverage', icon: Play, onPress: run.action.onPress }
      : undefined
  return (
    <>
      <SideSheet
        size="wide"
        open={repo !== undefined}
        onClose={onClose}
        title={repo?.path ?? 'Coverage'}
        {...(card
          ? {
              id: card.analysisId.slice(0, 8),
              copyId: card.analysisId,
              openAsPage: { to: '/analyses/$id', params: { id: card.analysisId }, search: {} },
              progress: {
                segments: lineSegments(card.totals),
                label: `${formatPercent(percentOf(card.totals.lines))} of lines covered`,
              },
            }
          : {})}
        {...(index !== undefined && total !== undefined ? { index, total } : {})}
        {...(onPrevious ? { onPrevious } : {})}
        {...(onNext ? { onNext } : {})}
        {...(runAction ? { quietActions: [runAction] as const } : {})}
        {...(repo
          ? {
              more: [
                {
                  label: 'Open repository',
                  icon: FolderGit2,
                  href: router.buildLocation({
                    to: '/repos/$',
                    params: { _splat: repoSplat(repo) },
                    search: { tab: 'quality', section: 'coverage' },
                  }).href,
                },
                ...(tests.markItem ? [tests.markItem] : []),
              ],
            }
          : {})}
        {...(data?.card
          ? {
              tabs: {
                items: coverageTabItems(data, options.excludes?.length),
                selected: tab,
                onSelect: (id: string) => setTab(coverageTabOf(id)),
                'aria-label': 'Coverage sections',
              },
            }
          : {})}
      >
        {!repo ? null : coverage.isPending ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Placeholder key={i} className="h-16" />
            ))}
          </div>
        ) : coverage.isError ? (
          <ErrorState error={coverage.error} />
        ) : noTests ? (
          <div className="flex flex-col gap-4">
            <NoTestsNotice tests={noTests} control={tests} />
            {coverage.data.card ? (
              <>
                <CoverageHeadline card={coverage.data.card} target={options.target} noTests />
                <CoverageTabBody repo={repo} data={coverage.data} tab={tab} options={options} />
              </>
            ) : null}
          </div>
        ) : coverage.data.card ? (
          <div className="flex flex-col gap-4">
            <CoverageHeadline card={coverage.data.card} target={options.target} />
            <CoverageTabBody repo={repo} data={coverage.data} tab={tab} options={options} />
          </div>
        ) : (
          <NotMeasured repo={repo} tests={tests} />
        )}
      </SideSheet>
      {run.dialog}
      {tests.dialog}
    </>
  )
}
