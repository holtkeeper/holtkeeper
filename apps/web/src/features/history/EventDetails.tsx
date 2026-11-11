import type { AuditEvent, PersonView } from '@holtkeeper/api'

import { formatDateTime, formatDuration } from '../../lib/format.ts'
import { changeValue, outcomeTone, targetLabel } from '../../lib/history.ts'
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

/** One audit event in the side sheet: who, what, the field-level diff and the raw details. */
export function EventDetails({ event, person }: { event: AuditEvent; person: PersonView }) {
  const details = event.details && Object.keys(event.details).length ? event.details : undefined
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
        <Field label="Hash" value={event.hash.slice(0, 16)} />
      </dl>

      {event.changes?.length ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted">Changes</h3>
          <div className="overflow-hidden rounded-lg border border-line">
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
        </section>
      ) : null}

      {details ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted">Details</h3>
          <pre className="mono overflow-x-auto rounded-lg border border-line bg-raise p-3 text-xs">
            {JSON.stringify(details, null, 2)}
          </pre>
        </section>
      ) : null}
    </div>
  )
}
