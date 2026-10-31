import type { LibraryIndexProgressView, LibrarySourceCoverage } from '@holtkeeper/api'
import { Hourglass, LoaderCircle } from 'lucide-react'

import { formatDateTime, formatDuration, formatRelative, plural } from '../../lib/format.ts'
import { coverageDone, coverageParts, runProgress, sourceLabel } from '../../lib/libraries.ts'
import { Panel, Table, Td, Th, Tooltip } from '../../ui/index.ts'

const toneColor = {
  success: 'var(--success)',
  danger: 'var(--danger)',
  warning: 'var(--warning)',
  default: 'var(--muted)',
} as const

/** The index run going on now: libraries done of all, the current one, time and waits. */
export function RunningIndex({ progress }: { progress: LibraryIndexProgressView }) {
  const { percent, elapsedMs, remainingMs } = runProgress(progress)
  return (
    <Panel
      title="Indexing now"
      description={
        <Tooltip content={formatDateTime(progress.startedAt)}>
          <span tabIndex={0}>Started {formatRelative(progress.startedAt)}</span>
        </Tooltip>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span className="flex items-center gap-2 font-medium">
            <LoaderCircle className="size-4 animate-spin text-muted" />
            {progress.done} of {plural(progress.total, 'library', 'libraries')}
          </span>
          <span className="tabular text-xs text-muted">
            {formatDuration(elapsedMs)} so far
            {remainingMs === undefined ? '' : ` · about ${formatDuration(remainingMs)} left`}
          </span>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-default"
          role="progressbar"
          aria-label="Libraries indexed in this run"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
        </div>
        {progress.library ? (
          <p className="text-xs text-muted">
            Working on <span className="font-mono text-foreground">{progress.library}</span>
          </p>
        ) : null}
        {progress.waitingUntil ? (
          <p className="flex items-center gap-1.5 text-xs text-warning">
            <Hourglass className="size-3.5" />
            Every GitHub token is used up; the run waits for the limit to reset{' '}
            {formatRelative(progress.waitingUntil)} and then goes on.
          </p>
        ) : null}
      </div>
    </Panel>
  )
}

/** Per source, how much of the indexed versions is done, failed or still to fetch. */
export function IndexCoverage({ coverage }: { coverage: readonly LibrarySourceCoverage[] }) {
  if (!coverage.length) return null
  return (
    <Panel
      title="Coverage"
      description="Versions in the matrix per source (libraries for issues); failed and missing ones are fetched on the next run"
    >
      <Table label="Coverage by source">
        <thead>
          <tr>
            <Th>Source</Th>
            <Th>Progress</Th>
            <Th align="right">Indexed</Th>
            <Th align="right">Nothing</Th>
            <Th align="right">Failed</Th>
            <Th align="right">Skipped</Th>
            <Th align="right">Not yet</Th>
          </tr>
        </thead>
        <tbody>
          {coverage.map((row) => {
            const parts = coverageParts(row)
            const total = parts.reduce((sum, part) => sum + part.count, 0)
            return (
              <tr key={row.source} className="hover:bg-default/40">
                <Td className="font-medium">{sourceLabel(row.source)}</Td>
                <Td className="min-w-48">
                  <div className="flex items-center gap-2">
                    <div className="flex h-2 w-full overflow-hidden rounded-full bg-default">
                      {parts.map((part) =>
                        part.count ? (
                          <div
                            key={part.key}
                            title={`${part.count} ${part.label}`}
                            style={{
                              width: `${(part.count / total) * 100}%`,
                              background: toneColor[part.tone],
                            }}
                          />
                        ) : null,
                      )}
                    </div>
                    <span className="tabular w-10 shrink-0 text-right text-xs text-muted">
                      {coverageDone(row)}%
                    </span>
                  </div>
                </Td>
                {parts.map((part) => (
                  <Td
                    key={part.key}
                    align="right"
                    className={
                      part.count && part.tone === 'danger'
                        ? 'tabular text-danger'
                        : part.count && part.tone === 'warning'
                          ? 'tabular text-warning'
                          : 'tabular'
                    }
                  >
                    {part.count}
                  </Td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </Table>
    </Panel>
  )
}
