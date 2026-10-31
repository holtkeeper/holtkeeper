import { Download, RotateCcw, ScrollText, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'

import { ApiError, messageOf } from '../../api/client.ts'
import { api } from '../../api/endpoints.ts'
import { useAuditLog, useAuditLogCount, useVerifyAuditLog } from '../../api/queries.ts'
import {
  type AuditLogForm,
  activeFilters,
  auditQueryOf,
  emptyAuditForm,
  verificationSummary,
} from '../../lib/audit-log.ts'
import { plural } from '../../lib/format.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  LoadMore,
  Notice,
  Page,
  Panel,
  Placeholder,
  Select,
  TextField,
  buttonClass,
  notify,
} from '../../ui/index.ts'
import { AuditEventsTable } from './AuditEventsTable.tsx'

const anyOption = 'any'

const outcomeOptions = [
  { id: anyOption, label: 'Any outcome' },
  { id: 'ok', label: 'ok' },
  { id: 'denied', label: 'denied' },
  { id: 'error', label: 'error' },
] as const

const viaOptions = [
  { id: anyOption, label: 'Any channel' },
  { id: 'ui', label: 'ui' },
  { id: 'api', label: 'api' },
  { id: 'webhook', label: 'webhook' },
  { id: 'job', label: 'job' },
  { id: 'system', label: 'system' },
] as const

const textFields = [
  ['actor', 'Actor', 'Actor id'],
  ['action', 'Action', 'credential.update or a prefix'],
  ['targetType', 'Target type', 'credential'],
  ['targetId', 'Target id', ''],
  ['repo', 'Repository', 'forge:group/project'],
] as const

const isUnconfigured = (error: unknown) => error instanceof ApiError && error.status === 503

function Filters({
  draft,
  onChange,
  onApply,
  onReset,
}: {
  draft: AuditLogForm
  onChange: (form: AuditLogForm) => void
  onApply: () => void
  onReset: () => void
}) {
  const set = (key: keyof AuditLogForm) => (value: string) =>
    onChange({ ...draft, [key]: value === anyOption ? '' : value })
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') onApply()
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {textFields.map(([key, label, placeholder]) => (
          <TextField
            key={key}
            label={label}
            value={draft[key]}
            onChange={set(key)}
            placeholder={placeholder}
            onKeyDown={onKeyDown}
            mono={key !== 'actor'}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="Outcome"
          options={outcomeOptions}
          value={draft.outcome || anyOption}
          onChange={set('outcome')}
          className="w-40"
        />
        <Select
          label="Via"
          options={viaOptions}
          value={draft.via || anyOption}
          onChange={set('via')}
          className="w-40"
        />
        <TextField
          label="From"
          type="date"
          value={draft.fromDay}
          onChange={set('fromDay')}
          className="w-44"
        />
        <TextField
          label="To"
          type="date"
          value={draft.toDay}
          onChange={set('toDay')}
          className="w-44"
        />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onPress={onReset}>
            <RotateCcw className="size-4" />
            Reset
          </Button>
          <Button variant="primary" onPress={onApply}>
            Apply
          </Button>
        </div>
      </div>
    </div>
  )
}

/** The tamper-evident audit log: filters, events with changes, chain verification and export. */
export function AuditLogPage() {
  const [draft, setDraft] = useState<AuditLogForm>(emptyAuditForm)
  const [applied, setApplied] = useState<AuditLogForm>(emptyAuditForm)
  const query = useMemo(() => auditQueryOf(applied), [applied])
  const log = useAuditLog(query)
  const count = useAuditLogCount(query)
  const verify = useVerifyAuditLog()
  const events = log.data?.pages.flatMap((page) => page.events) ?? []
  const filtered = activeFilters(query) > 0
  const unconfigured = isUnconfigured(log.error)

  if (unconfigured)
    return (
      <Page title="Audit log" icon="auditlog">
        <Notice tone="warning" title="No audit log configured">
          This server's store has no audit log, so changes are not recorded here.
        </Notice>
      </Page>
    )

  const summary = verify.data ? verificationSummary(verify.data) : undefined

  return (
    <Page
      title="Audit log"
      icon="auditlog"
      description={
        count.data
          ? `${plural(count.data.count, 'event')}${filtered ? ' match the filters' : ' recorded'}`
          : 'Every change made through the API, newest first'
      }
      actions={
        <>
          <Button
            variant="secondary"
            isPending={verify.isPending}
            onPress={() =>
              verify.mutate(
                {},
                { onError: (error) => notify.error('Verification failed', messageOf(error)) },
              )
            }
          >
            <ShieldCheck className="size-4" />
            Verify chain
          </Button>
          {(['csv', 'ndjson'] as const).map((format) => (
            <a
              key={format}
              href={api.auditLogExportUrl(query, format)}
              download
              className={buttonClass('secondary')}
            >
              <Download className="size-4" />
              {format.toUpperCase()}
            </a>
          ))}
        </>
      }
    >
      {summary ? (
        <Notice tone={summary.tone} title={summary.title}>
          {summary.description}
        </Notice>
      ) : null}

      <Panel title="Filters">
        <Filters
          draft={draft}
          onChange={setDraft}
          onApply={() => setApplied(draft)}
          onReset={() => {
            setDraft(emptyAuditForm)
            setApplied(emptyAuditForm)
          }}
        />
      </Panel>

      <Panel>
        {log.isPending ? (
          <Placeholder className="h-72" />
        ) : log.isError ? (
          <ErrorState error={log.error} />
        ) : events.length === 0 ? (
          <EmptyState
            icon={<ScrollText />}
            title={filtered ? 'No events match' : 'Nothing recorded yet'}
            {...(filtered ? { description: 'Loosen the filters to see more.' } : {})}
          />
        ) : (
          <AuditEventsTable
            events={events}
            footer={
              log.hasNextPage ? (
                <LoadMore
                  onLoad={() => void log.fetchNextPage()}
                  isPending={log.isFetchingNextPage}
                >
                  Load older
                </LoadMore>
              ) : null
            }
          />
        )}
      </Panel>
    </Page>
  )
}
