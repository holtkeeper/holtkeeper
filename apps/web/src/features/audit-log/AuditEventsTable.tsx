import type { AuditEvent } from '@holtkeeper/api'
import { ChevronRight } from 'lucide-react'
import { Fragment, type ReactNode, useState } from 'react'

import {
  changeValue,
  hasDetails,
  outcomeTone,
  statusClass,
  targetLabel,
} from '../../lib/audit-log.ts'
import { formatDateTime, formatDuration, formatRelative } from '../../lib/format.ts'
import { Button, Chip, Table, Td, Th } from '../../ui/index.ts'

function EventDetails({ event }: { event: AuditEvent }) {
  const details = Object.entries(event.details ?? {})
  return (
    <div className="flex flex-col gap-4 rounded-xl bg-default-soft p-4 text-xs">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        {(
          [
            ['Actor', `${event.actor.id} (${event.actor.provider})`],
            ['Repository', event.target.repo],
            [
              'Request',
              event.request ? `${event.request.method} ${event.request.path}` : undefined,
            ],
            ['Route', event.request?.route],
            ['Client', event.request?.ip],
            [
              'Duration',
              event.request?.durationMs !== undefined
                ? formatDuration(event.request.durationMs)
                : undefined,
            ],
            ['User agent', event.request?.userAgent],
            ['Sequence', `#${event.seq}`],
            ['Hash', event.hash.slice(0, 16)],
          ] as const
        ).map(([label, value]) =>
          value ? (
            <div key={label} className="min-w-0">
              <dt className="text-muted">{label}</dt>
              <dd className="truncate font-mono" title={value}>
                {value}
              </dd>
            </div>
          ) : null,
        )}
      </dl>

      {event.changes?.length ? (
        <div className="flex flex-col gap-1.5">
          <div className="font-medium">Changes</div>
          <Table label="Changed fields">
            <thead>
              <tr>
                <Th>Field</Th>
                <Th>Before</Th>
                <Th>After</Th>
              </tr>
            </thead>
            <tbody>
              {event.changes.map((change) => (
                <tr key={change.field}>
                  <Td className="font-mono text-xs">{change.field}</Td>
                  <Td className="max-w-80 break-all font-mono text-xs text-danger">
                    {changeValue(change.before)}
                  </Td>
                  <Td className="max-w-80 break-all font-mono text-xs text-success">
                    {changeValue(change.after)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : null}

      {details.length ? (
        <div className="flex flex-col gap-1.5">
          <div className="font-medium">Details</div>
          <dl className="flex flex-wrap gap-x-5 gap-y-1">
            {details.map(([key, value]) => (
              <div key={key} className="flex min-w-0 gap-1.5">
                <dt className="text-muted">{key}</dt>
                <dd className="break-all font-mono">{changeValue(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  )
}

/** Audit events with an expandable row for request, changes and details. */
export function AuditEventsTable({ events, footer }: { events: AuditEvent[]; footer?: ReactNode }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })

  return (
    <Table label="Audit events" footer={footer}>
      <thead>
        <tr>
          <Th className="w-8" />
          <Th>Time</Th>
          <Th>Actor</Th>
          <Th>Via</Th>
          <Th>Action</Th>
          <Th>Target</Th>
          <Th>Outcome</Th>
          <Th align="right">Status</Th>
        </tr>
      </thead>
      <tbody>
        {events.map((event) => {
          const expandable = hasDetails(event)
          const expanded = open.has(event.id)
          return (
            <Fragment key={event.id}>
              <tr>
                <Td className="w-8 pr-0">
                  {expandable ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      isIconOnly
                      aria-label={expanded ? 'Hide details' : 'Show details'}
                      onPress={() => toggle(event.id)}
                    >
                      <ChevronRight
                        className={`size-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
                      />
                    </Button>
                  ) : null}
                </Td>
                <Td className="whitespace-nowrap text-xs text-muted">
                  <time dateTime={event.at} title={formatDateTime(event.at)}>
                    {formatRelative(event.at)}
                  </time>
                </Td>
                <Td>
                  <div className="font-medium" title={event.actor.id}>
                    {event.actor.name}
                  </div>
                  <div className="text-xs text-muted">{event.actor.provider}</div>
                </Td>
                <Td>
                  <Chip>{event.via}</Chip>
                </Td>
                <Td className="font-mono text-xs">{event.action}</Td>
                <Td className="max-w-64">
                  <div className="truncate font-mono text-xs" title={targetLabel(event.target)}>
                    {targetLabel(event.target)}
                  </div>
                  {event.target.repo ? (
                    <div className="truncate text-xs text-muted">{event.target.repo}</div>
                  ) : null}
                </Td>
                <Td>
                  <Chip tone={outcomeTone(event.outcome)}>{event.outcome}</Chip>
                </Td>
                <Td align="right" className={`tabular ${statusClass(event.status)}`}>
                  {event.status ?? '—'}
                </Td>
              </tr>
              {expanded ? (
                <tr>
                  <td colSpan={8} className="border-b border-separator px-3 py-3">
                    <EventDetails event={event} />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          )
        })}
      </tbody>
    </Table>
  )
}
