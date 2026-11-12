import type { AuditEvent, PersonView } from '@holtkeeper/api'

import { auditScopeLabel, formatSeq } from '../../lib/audit-labels.ts'
import { changeValue, outcomeTone, targetLabel } from '../../lib/audit-log.ts'
import { formatDateTime, formatDuration } from '../../lib/format.ts'
import { Avatar, Tag } from '../../ui/index.ts'

function Field({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mono truncate text-xs" title={value}>
        {value}
      </dd>
    </div>
  )
}

/** A tab of an audit event's side sheet. */
export type EventSection = 'event' | 'changes' | 'details'

/** The raw details of an event, or `undefined` when it has none. */
export const eventDetails = (event: AuditEvent): Record<string, unknown> | undefined =>
  event.details && Object.keys(event.details).length ? event.details : undefined

/**
 * One audit event in a tab of the side sheet. Event: who, outcome, the request facts and its
 * place in the hash chain.
 * Changes: the field-level diff. Details: the raw details as JSON.
 */
export function EventDetails({
  event,
  person,
  section,
  checkedThrough,
}: {
  event: AuditEvent
  person: PersonView
  section: EventSection
  /** The last `seq` the newest chain check covered; unknown without `audit:read`. */
  checkedThrough?: number | undefined
}) {
  if (section === 'changes')
    return event.changes?.length ? (
      <div className="overflow-hidden rounded-lg border border-line text-[13px]">
        {event.changes.map((change) => (
          <div key={change.field} className="border-b border-line px-3 py-2 last:border-b-0">
            <div className="mono text-xs">{change.field}</div>
            <div className="mono mt-1 break-all text-xs text-bad">
              − {changeValue(change.before)}
            </div>
            <div className="mono break-all text-xs text-ok">+ {changeValue(change.after)}</div>
          </div>
        ))}
      </div>
    ) : (
      <p className="text-sm text-muted">No field-level changes recorded.</p>
    )
  if (section === 'details') {
    const details = eventDetails(event)
    return details ? (
      <pre className="mono overflow-x-auto rounded-lg border border-line bg-raise p-3 text-xs">
        {JSON.stringify(details, null, 2)}
      </pre>
    ) : (
      <p className="text-sm text-muted">No details recorded.</p>
    )
  }
  return (
    <div className="flex flex-col gap-5 text-[13px]">
      <div className="flex items-center gap-3">
        <Avatar src={person.avatarUrl} name={person.name} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{person.name}</div>
          <div className="mono truncate text-xs text-muted">
            {event.actor.id} · {event.actor.provider} · via {event.via}
          </div>
        </div>
        <Tag tone={outcomeTone(event.outcome)} dot>
          {event.outcome}
          {event.status !== undefined ? ` ${event.status}` : ''}
        </Tag>
      </div>

      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <Field label="When" value={formatDateTime(event.at)} />
        <Field label="Action" value={event.action} />
        <Field label="Target" value={targetLabel(event.target)} />
        <Field
          label="Object"
          value={event.target.id && `${event.target.type}:${event.target.id}`}
        />
        <Field
          label="Request"
          value={
            event.request && `${event.request.method} ${event.request.route ?? event.request.path}`
          }
        />
        <Field
          label="Duration"
          value={
            event.request?.durationMs !== undefined
              ? formatDuration(event.request.durationMs)
              : undefined
          }
        />
        <Field label="Client" value={event.request?.ip} />
        <Field label="User agent" value={event.request?.userAgent} />
        <Field label="Scope" value={auditScopeLabel(event)} />
        <Field label="Hash" value={event.hash.slice(0, 16)} />
        <Field
          label="Previous"
          value={
            event.seq > 1 ? `${event.prevHash.slice(0, 16)} ${formatSeq(event.seq - 1)}` : undefined
          }
        />
        <Field
          label="Checked"
          value={
            checkedThrough === undefined
              ? undefined
              : event.seq <= checkedThrough
                ? 'Covered by the last chain check'
                : 'Not yet, added after the last check'
          }
        />
      </dl>
    </div>
  )
}
