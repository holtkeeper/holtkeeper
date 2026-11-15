import type { SecretReportKind, SecretReportView } from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ShieldCheck } from 'lucide-react'
import { useState } from 'react'

import { ApiError, messageOf } from '../../api/client.ts'
import { useSecretReports, useUpdateSecretReport } from '../../api/queries.ts'
import { formatDateTime } from '../../lib/format.ts'
import { parseRepoKey, repoSplat } from '../../lib/repo.ts'
import {
  type ReportStatusFilter,
  exposureChannelLabels,
  filterReports,
  isAnonymousReport,
  repeatsLabel,
  reportStatusActions,
  reportStatusCounts,
  reportStatusFilterLabel,
  reportStatusFilters,
  reportStatusLabels,
  reportedLabel,
  secretKindLabels,
  secretsMatchCommand,
} from '../../lib/secret-reports.ts'
import {
  Button,
  CopyButton,
  CopyField,
  EmptyState,
  ErrorState,
  FilterButton,
  KeyValue,
  Notice,
  Page,
  Placeholder,
  SideSheet,
  Table,
  Tag,
  Td,
  TextField,
  Th,
  Tr,
  notify,
} from '../../ui/index.ts'
import { useConfigure } from '../settings/SettingsSheet.tsx'
import { LicenseButton } from './LicenseDialog.tsx'

const kindOptions = Object.entries(secretKindLabels).map(([id, label]) => ({ id, label }))
const kindIds = new Set<string>(Object.keys(secretKindLabels))
const isKind = (id: string): id is SecretReportKind => kindIds.has(id)

/**
 * Supply › Secret reports: secrets agents reported as exposed in their sessions, for people with
 * `credentials:read` on everything, with status and notes for `credentials:write`. `?report=`
 * opens one report in the side sheet.
 */
export function SecretReportsPage() {
  const search = useSearch({ from: '/app/supply/secret-reports' })
  const navigate = useNavigate({ from: '/supply/secret-reports' })
  const reports = useSecretReports()
  const settings = useConfigure('Secret report settings', ['security.secretReports'])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<ReportStatusFilter>('open')
  const [kinds, setKinds] = useState<SecretReportKind[]>([])
  const off = reports.error instanceof ApiError && reports.error.status === 404

  const all = reports.data?.reports ?? []
  const counts = reportStatusCounts(all)
  const shown = filterReports(all, { status, kinds, query })
  const open = (report: string | undefined) =>
    void navigate({ search: report ? { report } : {}, replace: true })
  const selected = all.find((report) => report.id === search.report)
  const index = selected ? shown.findIndex((report) => report.id === selected.id) : -1

  return (
    <Page
      crumbs={[{ label: 'Secret reports' }]}
      description="Secrets agents reported as exposed in their sessions, to rotate them"
      search={{
        value: query,
        onChange: setQuery,
        'aria-label': 'Filter secret reports',
        placeholder: 'Identifier, service or repository',
      }}
      filters={
        <>
          <FilterButton
            label="Status"
            single
            all="Open"
            options={reportStatusFilters.map((id) => ({
              id,
              label: `${reportStatusFilterLabel(id)} (${counts[id]})`,
            }))}
            value={[status]}
            onChange={(next) =>
              setStatus(reportStatusFilters.find((id) => id === next[0]) ?? 'open')
            }
          />
          <FilterButton
            label="Kind"
            options={kindOptions}
            value={kinds}
            onChange={(next) => setKinds(next.filter(isKind))}
          />
        </>
      }
      configure={settings.configure}
    >
      <div className="flex flex-col gap-4">
        <Notice title="Reports are for rotating secrets only">
          Under the license this feature runs on, reports, and the absence of reports, must never be
          used for sanctions or performance reviews, and nobody may try to identify anonymous
          reporters. <LicenseButton />
        </Notice>
        {reports.isPending ? (
          <Placeholder className="h-64" />
        ) : off ? (
          <Notice title="Secret reports are off">
            This deployment turned the feature off (<code>server.secretReports: false</code>), so
            agents cannot report exposed secrets.
          </Notice>
        ) : reports.isError ? (
          <ErrorState error={reports.error} />
        ) : shown.length ? (
          <ReportTable reports={shown} selected={search.report} onOpen={open} />
        ) : (
          <EmptyState
            icon={<ShieldCheck />}
            title={all.length ? 'No report matches' : 'No secret reports'}
            description={
              all.length
                ? 'Change the status, kind or text filter to see more reports.'
                : 'Agents report keys, tokens and passwords of the organization that show up in their sessions.'
            }
          />
        )}
      </div>
      {selected && reports.data ? (
        <ReportSheet
          key={selected.id}
          report={selected}
          canWrite={reports.data.canWrite}
          onClose={() => open(undefined)}
          {...(index >= 0 ? { index, total: shown.length } : {})}
          {...(index > 0 ? { onPrevious: () => open(shown[index - 1]?.id) } : {})}
          {...(index >= 0 && index < shown.length - 1
            ? { onNext: () => open(shown[index + 1]?.id) }
            : {})}
        />
      ) : null}
      {settings.sheet}
    </Page>
  )
}

function RepoLink({ repo }: { repo: string }) {
  const ref = parseRepoKey(repo)
  return ref ? (
    <Link
      to="/repos/$"
      params={{ _splat: repoSplat(ref) }}
      className="mono text-[12.5px] hover:underline"
      onClick={(event) => event.stopPropagation()}
    >
      {ref.path}
    </Link>
  ) : (
    <span className="mono text-[12.5px]">{repo}</span>
  )
}

function StatusTag({ report }: { report: SecretReportView }) {
  const status = reportStatusLabels[report.status]
  return (
    <Tag tone={status.tone} dot>
      {status.label}
    </Tag>
  )
}

function ReportTable({
  reports,
  selected,
  onOpen,
}: {
  reports: readonly SecretReportView[]
  selected: string | undefined
  onOpen: (id: string) => void
}) {
  return (
    <Table label="Secret reports">
      <thead>
        <tr>
          <Th>Status</Th>
          <Th>Kind</Th>
          <Th>Identifier</Th>
          <Th>Masked</Th>
          <Th>Service</Th>
          <Th>Repository</Th>
          <Th>Channel</Th>
          <Th>Reported</Th>
          <Th>Reporter</Th>
          <Th align="right">Repeats</Th>
        </tr>
      </thead>
      <tbody>
        {reports.map((report) => (
          <Tr key={report.id} selected={report.id === selected} onClick={() => onOpen(report.id)}>
            <Td>
              <StatusTag report={report} />
            </Td>
            <Td className="whitespace-nowrap">{secretKindLabels[report.kind]}</Td>
            <Td className="mono text-[12.5px]">{report.identifier}</Td>
            <Td className="mono text-[12.5px] text-muted">{report.masked}</Td>
            <Td className="text-muted">{report.service ?? '—'}</Td>
            <Td>
              {report.repo ? (
                <RepoLink repo={report.repo} />
              ) : (
                <span className="text-muted">—</span>
              )}
            </Td>
            <Td className="whitespace-nowrap text-muted">
              {exposureChannelLabels[report.channel]}
            </Td>
            <Td className="whitespace-nowrap text-muted">{reportedLabel(report)}</Td>
            <Td className={report.reporter ? '' : 'text-muted'}>
              {report.reporter?.name ?? 'Anonymous'}
            </Td>
            <Td align="right" className="mono text-muted">
              {repeatsLabel(report.repeats)}
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}

function ReportSheet({
  report,
  canWrite,
  onClose,
  ...position
}: {
  report: SecretReportView
  canWrite: boolean
  onClose: () => void
  index?: number
  total?: number
  onPrevious?: () => void
  onNext?: () => void
}) {
  const update = useUpdateSecretReport()
  const [note, setNote] = useState(report.note ?? '')
  const save = (input: { status?: SecretReportView['status']; note?: string }, done: string) =>
    update.mutate(
      { reportId: report.id, input },
      {
        onSuccess: () => notify.success(done),
        onError: (error) => notify.error('Not updated', messageOf(error)),
      },
    )
  const anonymous = isAnonymousReport(report)
  return (
    <SideSheet
      open
      onClose={onClose}
      id={report.masked}
      title={report.identifier}
      {...position}
      {...(canWrite
        ? {
            footer: (
              <div className="flex flex-wrap gap-2">
                {reportStatusActions(report.status).map((action) => (
                  <Button
                    key={action.status}
                    size="sm"
                    variant={action.status === 'rotated' ? 'primary' : 'secondary'}
                    isDisabled={update.isPending}
                    onPress={() =>
                      save(
                        { status: action.status },
                        `Marked ${reportStatusLabels[action.status].label.toLowerCase()}`,
                      )
                    }
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            ),
          }
        : {})}
    >
      <div className="flex flex-col gap-5">
        <KeyValue
          rows={[
            { label: 'Status', value: <StatusTag report={report} /> },
            { label: 'Kind', value: secretKindLabels[report.kind] },
            { label: 'Identifier', value: <span className="mono">{report.identifier}</span> },
            { label: 'Masked', value: <span className="mono">{report.masked}</span> },
            { label: 'Service', value: report.service },
            { label: 'Repository', value: report.repo ? <RepoLink repo={report.repo} /> : null },
            { label: 'Channel', value: exposureChannelLabels[report.channel] },
            {
              label: 'Reported',
              value: anonymous ? `${reportedLabel(report)} (day only)` : reportedLabel(report),
            },
            { label: 'Reporter', value: report.reporter?.name ?? 'Anonymous' },
            {
              label: 'Repeats',
              value: report.repeats
                ? `Reported ${repeatsLabel(report.repeats)} more while open`
                : null,
            },
            {
              label: 'Updated',
              value: report.updatedAt
                ? `${formatDateTime(report.updatedAt)}${report.updatedBy ? ` by ${report.updatedBy}` : ''}`
                : null,
            },
          ]}
        />
        {report.circumstances ? (
          <section className="flex flex-col gap-1.5">
            <h4 className="text-[12.5px] font-semibold">Circumstances</h4>
            <p className="text-[12.5px] whitespace-pre-wrap text-muted">{report.circumstances}</p>
          </section>
        ) : null}
        {report.fingerprint ? (
          <section className="flex flex-col gap-2">
            <h4 className="flex items-center gap-2 text-[12.5px] font-semibold">
              Fingerprint
              <span className="mono font-normal">{report.fingerprint}</span>
              <CopyButton size="sm" variant="ghost" text={() => report.fingerprint ?? ''}>
                Copy
              </CopyButton>
            </h4>
            <p className="text-xs text-muted">
              The first 16 hex characters of the value's SHA-256. To find which secret it is, run
              this against OpenBao or Vault with a token in <code>BAO_TOKEN</code> or{' '}
              <code>VAULT_TOKEN</code>; values are hashed locally and never leave the machine.
            </p>
            <CopyField label="Match command" value={secretsMatchCommand(report.fingerprint)} />
          </section>
        ) : null}
        {canWrite ? (
          <section className="flex flex-col gap-2">
            <TextField
              label="Note"
              placeholder="Rotated in the secret store, owner informed, …"
              value={note}
              onChange={setNote}
              multiline
              rows={3}
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                onPress={() => save({ note: note.trim() }, 'Note saved')}
                isPending={update.isPending}
                isDisabled={note.trim() === (report.note ?? '')}
              >
                Save note
              </Button>
            </div>
          </section>
        ) : report.note ? (
          <section className="flex flex-col gap-1.5">
            <h4 className="text-[12.5px] font-semibold">Note</h4>
            <p className="text-[12.5px] whitespace-pre-wrap text-muted">{report.note}</p>
          </section>
        ) : null}
      </div>
    </SideSheet>
  )
}
