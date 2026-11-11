import type { RepoRef } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { useRepoCoverage } from '../../api/queries.ts'
import {
  coverageTone,
  formatPercent,
  formatPoints,
  percentOf,
  pointsTone,
} from '../../lib/coverage.ts'
import { formatRelative } from '../../lib/format.ts'
import { repoKey } from '../../lib/repo.ts'
import { statusColor } from '../../ui/colors.ts'
import {
  EmptyState,
  ErrorState,
  LinkButton,
  Placeholder,
  SegmentBar,
  SideSheet,
  Table,
  Tag,
  Td,
  Th,
} from '../../ui/index.ts'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'

interface Counts {
  covered: number
  total: number
}

function Share({ counts }: { counts: Counts | undefined }) {
  const value = percentOf(counts)
  return (
    <span className="tabular" style={{ color: statusColor[coverageTone(value)] }}>
      {formatPercent(value)}
    </span>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </section>
  )
}

function Body({ repo }: { repo: RepoRef }) {
  const coverage = useRepoCoverage(repo)
  if (coverage.isPending)
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <Placeholder key={i} className="h-16" />
        ))}
      </div>
    )
  if (coverage.isError) return <ErrorState error={coverage.error} />
  const { card, groups, worst, changes } = coverage.data
  if (!card)
    return (
      <EmptyState
        title="No coverage recorded yet"
        action={<RunJobButton repo={repo} analyzer="coverage" label="Run coverage" />}
      />
    )
  const { totals } = card
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>
          Lines <Share counts={totals.lines} />
        </span>
        {totals.branches ? (
          <span>
            · Branches <Share counts={totals.branches} />
          </span>
        ) : null}
        {totals.functions ? (
          <span>
            · Functions <Share counts={totals.functions} />
          </span>
        ) : null}
        <span>· {card.tools.join(', ') || 'unknown tools'}</span>
        <span>· {formatRelative(card.createdAt)}</span>
      </div>
      <Section title="By package or folder">
        <Table label="Coverage by package or folder">
          <thead>
            <tr>
              <Th>Path</Th>
              <Th className="w-32">Lines</Th>
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
      </Section>
      {worst.length ? (
        <Section title="Most uncovered lines">
          <Table label="Files with the most uncovered lines">
            <thead>
              <tr>
                <Th>File</Th>
                <Th align="right">Uncovered</Th>
                <Th align="right">Lines</Th>
              </tr>
            </thead>
            <tbody>
              {worst.map((file) => (
                <tr key={file.file}>
                  <Td className="mono text-xs">
                    {file.file}
                    {file.loaded === false ? (
                      <Tag tone="danger" className="ml-2">
                        no tests
                      </Tag>
                    ) : null}
                  </Td>
                  <Td align="right" className="tabular">
                    {file.lines.total - file.lines.covered}
                  </Td>
                  <Td align="right">
                    <Share counts={file.lines} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Section>
      ) : null}
      {changes.length ? (
        <Section title="Moved since the previous record">
          <ul className="flex flex-col gap-1 text-xs">
            {changes.map((change) => (
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
                    {formatPoints(change.delta)}
                  </Tag>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <LinkButton
          to="/analyses/$id"
          params={{ id: card.analysisId }}
          search={{}}
          variant="secondary"
          size="sm"
        >
          Full record
        </LinkButton>
        <RunJobButton repo={repo} analyzer="coverage" label="Run now" variant="ghost" size="sm" />
      </div>
    </div>
  )
}

/**
 * The coverage breakdown of `repo` in a side sheet: shares, per package or folder, the files
 * with the most uncovered lines and the files that moved since the previous record. Closed while
 * `repo` is unset.
 */
export function CoverageSheet({
  repo,
  onClose,
  index,
  total,
  onPrevious,
  onNext,
}: {
  repo: RepoRef | undefined
  onClose: () => void
  index?: number
  total?: number
  onPrevious?: () => void
  onNext?: () => void
}) {
  return (
    <SideSheet
      open={repo !== undefined}
      onClose={onClose}
      title={
        repo ? (
          <Link to="/repos/view" search={{ repo: repoKey(repo) }} className="hover:underline">
            {repo.path}
          </Link>
        ) : (
          'Coverage'
        )
      }
      {...(index !== undefined && total !== undefined ? { index, total } : {})}
      {...(onPrevious ? { onPrevious } : {})}
      {...(onNext ? { onNext } : {})}
    >
      {repo ? <Body repo={repo} /> : null}
    </SideSheet>
  )
}
