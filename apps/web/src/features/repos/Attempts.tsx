import type { ListingAttemptView } from '@holtkeeper/api'

import { formatDate, formatDuration, formatRelative } from '../../lib/format.ts'
import { Chip, Table, Tag, Td, Th } from '../../ui/index.ts'
import type { UpdateEvent } from './updates.ts'

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

/** Webhook deliveries and polls of a repository in one table, newest first. */
export function UpdateEvents({ events }: { events: readonly UpdateEvent[] }) {
  const now = new Date()
  if (events.length === 0)
    return <p className="text-sm text-muted">No webhook deliveries or polls yet.</p>
  return (
    <Table label="Recent events">
      <thead>
        <tr>
          <Th>When</Th>
          <Th>Via</Th>
          <Th>Event</Th>
          <Th>Result</Th>
          <Th align="right">Took</Th>
        </tr>
      </thead>
      <tbody>
        {events.map((event, index) => (
          <tr key={`${event.at}-${event.via}-${index}`}>
            <Td>
              <When at={event.at} now={now} />
            </Td>
            <Td>
              <Tag tone={event.via === 'webhook' ? 'info' : 'default'}>
                {event.via === 'webhook' ? 'Webhook' : 'Poll'}
              </Tag>
            </Td>
            <Td className="mono">{event.event}</Td>
            <Td>
              {event.failed ? (
                <span className="text-danger" title={event.result}>
                  {event.result}
                </span>
              ) : (
                event.result
              )}
            </Td>
            <Td align="right" className="mono">
              {formatDuration(event.durationMs)}
            </Td>
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
