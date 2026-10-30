import type { ListingAttemptView, PollAttemptView } from '@holtkeeper/api'

import { formatDate, formatDuration, formatRelative } from '../../lib/format.ts'
import { Chip, Table, Td, Th } from '../../ui/index.ts'

function When({ at, now }: { at: string; now: Date }) {
  return <span title={formatDate(at)}>{formatRelative(at, now)}</span>
}

function Trigger({ trigger }: { trigger: 'scheduled' | 'manual' }) {
  return (
    <Chip size="sm" tone={trigger === 'manual' ? 'accent' : 'default'}>
      {trigger === 'manual' ? 'By hand' : 'Scheduled'}
    </Chip>
  )
}

function Outcome({ error, children }: { error?: string | undefined; children: string }) {
  return error ? (
    <span className="text-danger" title={error}>
      {error}
    </span>
  ) : (
    <span>{children}</span>
  )
}

/** Recent polls of a repository, newest first. */
export function PollAttempts({ attempts }: { attempts: readonly PollAttemptView[] }) {
  const now = new Date()
  if (attempts.length === 0) return <p className="text-sm text-muted">No polls yet.</p>
  return (
    <Table label="Recent polls">
      <thead>
        <tr>
          <Th>When</Th>
          <Th>How</Th>
          <Th>Result</Th>
          <Th align="right">Requests</Th>
          <Th align="right">Took</Th>
        </tr>
      </thead>
      <tbody>
        {attempts.map((attempt) => (
          <tr key={`${attempt.at}-${attempt.trigger}`}>
            <Td>
              <When at={attempt.at} now={now} />
            </Td>
            <Td>
              <Trigger trigger={attempt.trigger} />
            </Td>
            <Td>
              <Outcome error={attempt.error}>
                {`${attempt.events ?? 0} change(s), ${attempt.enqueued ?? 0} job(s)`}
              </Outcome>
            </Td>
            <Td align="right">{attempt.requests ?? '—'}</Td>
            <Td align="right">{formatDuration(attempt.durationMs)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

/** Recent listings of a group's repositories, newest first. */
export function ListingAttempts({ attempts }: { attempts: readonly ListingAttemptView[] }) {
  const now = new Date()
  if (attempts.length === 0) return <p className="text-sm text-muted">Not listed yet.</p>
  return (
    <Table label="Recent listings">
      <thead>
        <tr>
          <Th>When</Th>
          <Th>How</Th>
          <Th>Result</Th>
          <Th align="right">Took</Th>
        </tr>
      </thead>
      <tbody>
        {attempts.map((attempt) => (
          <tr key={`${attempt.at}-${attempt.trigger}`}>
            <Td>
              <When at={attempt.at} now={now} />
            </Td>
            <Td>
              <Trigger trigger={attempt.trigger} />
            </Td>
            <Td>
              <Outcome error={attempt.error}>{`${attempt.repos ?? 0} repositories`}</Outcome>
            </Td>
            <Td align="right">{formatDuration(attempt.durationMs)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}
