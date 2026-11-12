import { useCredentials, useSettings } from '../../api/queries.ts'
import { useIntegrationForges } from '../../api/settings-ai.ts'
import { credentialStatus, limitRows, needsAttention } from '../../lib/credential-status.ts'
import { formatRelative } from '../../lib/format.ts'
import { describeScope } from '../../lib/scope.ts'
import { settingAnchor } from '../../lib/settings-sections.ts'
import { trackerRows } from '../../lib/trackers.ts'
import { Strip, type StripCell, Table, Tag, Td, Th, Tr } from '../../ui/index.ts'
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
 * Settings › Integrations › Trackers and Request limits: only what is stored in the `trackers`
 * and `limits.credentials` settings, with a link to their editors below.
 */
export function ConfiguredTables() {
  const { can } = useSession()
  const settings = useSettings(can('settings:read'))
  const credentials = useCredentials(can('credentials:read'))
  if (!settings.data) return null
  const trackers = trackerRows(settings.data.settings)
  const limits = limitRows(settings.data.settings, credentials.data?.credentials ?? [])
  return (
    <>
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
      <SettingsSection
        title={<span id="limits">Request limits</span>}
        description="How hard Holtkeeper may call each service; only limits someone set are listed, the rest keep the defaults of their kind."
        actions={
          <a
            className="text-xs text-muted hover:text-foreground"
            href={`#${settingAnchor('limits.credentials')}`}
          >
            Edit limits
          </a>
        }
      >
        {limits.length ? (
          <Table label="Request limits">
            <thead>
              <tr>
                <Th>Credential</Th>
                <Th>Limit</Th>
              </tr>
            </thead>
            <tbody>
              {limits.map((row) => (
                <Tr key={`${row.settingId}:${row.key}`}>
                  <Td>
                    {row.credential ? (
                      <>
                        {row.credential.name} <Tag mono>{row.credential.kind}</Tag>
                      </>
                    ) : (
                      <span className="mono text-xs">
                        {row.key} <span className="text-muted">· no such credential</span>
                      </span>
                    )}
                  </Td>
                  <Td className="mono text-xs">{row.limit}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="text-sm text-muted">
            No limit is configured; every credential keeps the defaults of its kind.
          </p>
        )}
      </SettingsSection>
    </>
  )
}
