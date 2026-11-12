import type { JobFailureGroup } from '@holtkeeper/api'
import { ChevronRight } from 'lucide-react'

import { formatDateTime, formatRelative, shortId } from '../../lib/format.ts'
import {
  Button,
  ErrorState,
  Placeholder,
  SegmentedTabs,
  Table,
  Td,
  Th,
  Tr,
} from '../../ui/index.ts'

/** Time ranges of the recurring failures, in days. */
const failureRanges = [
  { id: '1', label: '24 h' },
  { id: '7', label: '7 d' },
  { id: '30', label: '30 d' },
] as const

/** A recurring-failures time range in days, as the segment ids. */
export type FailureRange = (typeof failureRanges)[number]['id']

/**
 * Runs that failed for good, grouped by analyzer and failure signature (`GET /api/jobs/failures`),
 * as a section under the runs table. A row filters the runs to that failure; the id opens the
 * latest run with it.
 */
export function RecurringFailures({
  failures,
  range,
  onRange,
  labelOf,
  now,
  onShow,
  onLatest,
  onAll,
}: {
  failures: {
    data?: { failures: JobFailureGroup[] }
    isPending: boolean
    isError: boolean
    error: unknown
  }
  range: FailureRange
  onRange: (range: FailureRange) => void
  labelOf: (kind: string) => string
  now: Date
  onShow: (group: JobFailureGroup) => void
  onLatest: (jobId: string) => void
  /** Switches to the Failures segment; left out while it is shown. */
  onAll?: () => void
}) {
  const groups = failures.data?.failures ?? []
  const rangeLabel = failureRanges.find((item) => item.id === range)?.label ?? ''
  return (
    <section aria-labelledby="recurring-failures" className="border-t border-line">
      <header className="flex flex-wrap items-center gap-3 px-3.5 py-3">
        <h2 id="recurring-failures" className="text-[13px] font-semibold">
          Recurring failures
          <span className="ms-2 text-xs font-normal text-muted">
            grouped by error · last {rangeLabel}
          </span>
        </h2>
        <span className="flex-1" />
        <SegmentedTabs
          aria-label="Time range"
          selected={range}
          onSelect={(id) => {
            const next = failureRanges.find((item) => item.id === id)
            if (next) onRange(next.id)
          }}
          items={failureRanges}
        />
        {onAll ? (
          <Button size="sm" variant="ghost" onPress={onAll}>
            All failures
            <ChevronRight aria-hidden className="size-3.5" />
          </Button>
        ) : null}
      </header>
      {failures.isPending ? (
        <Placeholder className="mx-3.5 mb-3 h-24" />
      ) : failures.isError ? (
        <ErrorState error={failures.error} />
      ) : groups.length === 0 ? (
        <p className="px-3.5 pb-4 text-xs text-muted">Nothing failed for good in this range.</p>
      ) : (
        <Table label="Recurring failures">
          <thead>
            <tr>
              <Th>Analyzer</Th>
              <Th>Failure</Th>
              <Th align="right">Runs</Th>
              <Th align="right">Repositories</Th>
              <Th>Last seen</Th>
              <Th>Latest</Th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Tr key={`${group.analyzer}:${group.errorSignature}`} onClick={() => onShow(group)}>
                <Td>{labelOf(group.analyzer)}</Td>
                <Td className="max-w-[28rem]">
                  <span className="mono block truncate text-xs text-bad" title={group.error}>
                    {group.errorSignature || '(no message)'}
                  </span>
                </Td>
                <Td align="right">
                  <span className="mono tabular text-bad">{group.count}×</span>
                </Td>
                <Td align="right">
                  <span className="mono tabular text-muted">{group.repos}</span>
                </Td>
                <Td className="whitespace-nowrap">
                  <time
                    dateTime={group.lastAt}
                    title={`First ${formatDateTime(group.firstAt)}, last ${formatDateTime(group.lastAt)}`}
                    className="text-muted"
                  >
                    {formatRelative(group.lastAt, now)}
                  </time>
                </Td>
                <Td>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      onLatest(group.latestJobId)
                    }}
                    className="mono text-xs text-muted hover:underline"
                  >
                    {shortId(group.latestJobId)}
                  </button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  )
}
