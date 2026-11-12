import { Pencil } from 'lucide-react'

import { useLimitUsage } from '../../api/limits.ts'
import { useCredentials, useDescribeScope, useSettings } from '../../api/queries.ts'
import { useIntegrationForges } from '../../api/settings-ai.ts'
import {
  type HourMeter,
  credentialStatus,
  limitUsageViews,
  needsAttention,
} from '../../lib/credential-status.ts'
import { formatRelative } from '../../lib/format.ts'
import { settingAnchor } from '../../lib/settings-sections.ts'
import { trackerRows } from '../../lib/trackers.ts'
import { type StatusTone, statusColor } from '../../ui/colors.ts'
import {
  Dot,
  ErrorState,
  Placeholder,
  Strip,
  type StripCell,
  Table,
  Tag,
  Td,
  Th,
  Tr,
} from '../../ui/index.ts'
import { SettingsSection } from '../settings/SettingsSection.tsx'
import { useSession } from '../shell/session.ts'

/** The line over Settings › Integrations: forges and repositories, webhooks, credentials. */
export function IntegrationsStrip() {
  const { can, canGlobal } = useSession()
  const forges = useIntegrationForges(canGlobal('settings:read'))
  const credentials = useCredentials(can('credentials:read'))
  const now = new Date()
  const list = forges.data?.forges ?? []
  const attention = (credentials.data?.credentials ?? []).filter((credential) =>
    needsAttention(credentialStatus(credential, now)),
  ).length
  const cells: StripCell[] = [
    ...(forges.data
      ? [
          {
            value: list.length,
            label: `${list.length === 1 ? 'forge' : 'forges'} ·`,
            caption: `${list.reduce((sum, forge) => sum + forge.repos, 0)} repositories`,
          },
          ...list.map((forge) => ({
            prefix: `${forge.id}:`,
            value: forge.lastWebhookAt ? 'webhook' : 'polling',
            label: forge.lastWebhookAt ? `last ${formatRelative(forge.lastWebhookAt, now)}` : '',
            tone: forge.lastWebhookAt ? ('success' as const) : ('none' as const),
          })),
        ]
      : []),
    ...(credentials.data
      ? [
          { value: credentials.data.credentials.length, label: 'credentials' },
          ...(attention
            ? [{ value: attention, label: 'need attention', tone: 'danger' as const }]
            : []),
        ]
      : []),
  ]
  if (!cells.length) return null
  return (
    <Strip
      cells={cells}
      label="Integrations at a glance"
      className="rounded-xl border border-line"
    />
  )
}

/**
 * Settings › Integrations › Trackers (what is stored in the `trackers` setting) and Request
 * limits (live usage of every credential's limits), with links to their editors.
 */
export function ConfiguredTables() {
  return (
    <>
      <TrackersTable />
      <RequestLimitsTable />
    </>
  )
}

function TrackersTable() {
  const describeScope = useDescribeScope()
  const { can } = useSession()
  const settings = useSettings(can('settings:read'))
  if (!settings.data) return null
  const trackers = trackerRows(settings.data.settings)
  return (
    <SettingsSection
      title={<span id="trackers">Trackers</span>}
      description="Find things like feature flags or ticket keys in code and commits, then report them."
      actions={
        <a
          className="text-xs text-muted hover:text-foreground"
          href={`#${settingAnchor('trackers')}`}
        >
          Open editor
        </a>
      }
    >
      {trackers.length ? (
        <Table label="Trackers">
          <thead>
            <tr>
              <Th>Tracker</Th>
              <Th>Id</Th>
              <Th>One item is a</Th>
              <Th>Reads from</Th>
              <Th align="right">Rules</Th>
              <Th>Reports to</Th>
              <Th>Applies to</Th>
            </tr>
          </thead>
          <tbody>
            {trackers.map((tracker) => (
              <Tr key={`${tracker.settingId}:${tracker.id}`}>
                <Td>{tracker.name}</Td>
                <Td className="mono text-xs">{tracker.id}</Td>
                <Td>{tracker.entity}</Td>
                <Td className="mono text-xs">{tracker.sources.join(', ') || '—'}</Td>
                <Td align="right" className="mono">
                  {tracker.rules}
                </Td>
                <Td className="mono text-xs">{tracker.outputs.join(', ') || '—'}</Td>
                <Td className="mono text-xs">{describeScope(tracker.scope)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="text-sm text-muted">No tracker is configured.</p>
      )}
    </SettingsSection>
  )
}

function HourBar({ meter, tone }: { meter: HourMeter; tone: StatusTone }) {
  return (
    <span
      role="meter"
      aria-label={`${meter.unit} used in the last hour`}
      aria-valuemin={0}
      aria-valuemax={meter.max}
      aria-valuenow={Math.min(meter.used, meter.max)}
      className="inline-block h-1.5 w-16 shrink-0 overflow-hidden rounded-sm bg-line-strong"
    >
      <span
        className="block h-full rounded-sm"
        style={{ width: `${meter.share * 100}%`, background: statusColor[tone] }}
      />
    </span>
  )
}

function RequestLimitsTable() {
  const { canGlobal } = useSession()
  const allowed = canGlobal('settings:read')
  const usage = useLimitUsage(allowed)
  if (!allowed) return null
  const now = new Date()
  const rows = usage.data ? limitUsageViews(usage.data.rows, now) : []
  const editHref = `#${settingAnchor('limits.credentials')}`
  return (
    <SettingsSection
      title={<span id="limits">Request limits</span>}
      description={`How hard Holtkeeper may call each service; work over a limit waits in a queue. Counts cover Holtkeeper's own calls${usage.data && !usage.data.shared ? ' made by this server process' : ''} and refresh every 15 seconds.`}
      actions={
        <a className="text-xs text-muted hover:text-foreground" href={editHref}>
          Edit limits
        </a>
      }
    >
      {usage.isPending ? (
        <Placeholder className="h-32" />
      ) : usage.error ? (
        <ErrorState error={usage.error} />
      ) : rows.length ? (
        <Table label="Request limits">
          <thead>
            <tr>
              <Th>Credential</Th>
              <Th>Limit</Th>
              <Th>Used, last hour</Th>
              <Th align="right">At once</Th>
              <Th>Daily cap</Th>
              <Th>Status</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Tr key={row.key}>
                <Td>
                  {row.missing ? (
                    <span className="mono text-xs">
                      {row.name} <span className="text-muted">· no such credential</span>
                    </span>
                  ) : (
                    <>
                      <span className="mono">{row.name}</span>{' '}
                      {row.kind ? <Tag mono>{row.kind}</Tag> : null}
                    </>
                  )}
                </Td>
                <Td>
                  <div className="mono text-xs">{row.limit}</div>
                  <div className="text-xs text-muted">{row.limitDetail}</div>
                </Td>
                <Td>
                  <span className="flex items-center gap-2">
                    {row.meter ? <HourBar meter={row.meter} tone={row.status.tone} /> : null}
                    <span className="mono text-xs">{row.used}</span>
                  </span>
                </Td>
                <Td align="right" className="mono text-xs text-muted">
                  {row.atOnce}
                </Td>
                <Td className="mono text-xs text-muted">{row.daily}</Td>
                <Td>
                  <span className="flex items-center gap-1.5">
                    <Dot tone={row.status.tone} />
                    {row.status.label}
                  </span>
                  {row.status.why ? (
                    <div className="text-xs text-muted">{row.status.why}</div>
                  ) : null}
                </Td>
                <Td align="right">
                  <a
                    className="text-muted hover:text-foreground"
                    href={editHref}
                    aria-label={`Edit limit for ${row.name}`}
                  >
                    <Pencil className="size-3.5" aria-hidden />
                  </a>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="text-sm text-muted">No credential has a request limit.</p>
      )}
    </SettingsSection>
  )
}
