import type { FindingGroup, RepoRef } from '@holtkeeper/api'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ShieldOff } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { api } from '../../api/endpoints.ts'
import { keys, useFindings, useRepos, useSettings } from '../../api/queries.ts'
import { formatDate, isoDay, plural } from '../../lib/format.ts'
import { repoKey } from '../../lib/repo.ts'
import { describeScope } from '../../lib/scope.ts'
import {
  type AllowlistRow,
  type AllowlistState,
  allowlistRows,
  allowlistStateLabel,
  findingKey,
  inDays,
  isFutureDay,
  scopeCovers,
} from '../../lib/security.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  Placeholder,
  Strip,
  Table,
  Tag,
  Td,
  TextField,
  Th,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

const stateTone: Record<AllowlistState, 'danger' | 'warning' | 'success' | 'default'> = {
  expired: 'danger',
  expiring: 'warning',
  active: 'success',
  permanent: 'default',
}

function useRenew() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.renewAllowlist,
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.settings }),
        client.invalidateQueries({ queryKey: ['audit-runs'] }),
        client.invalidateQueries({ queryKey: keys.inbox }),
      ]),
  })
}

function Renew({ row }: { row: AllowlistRow }) {
  const renew = useRenew()
  const [editing, setEditing] = useState(false)
  const today = isoDay(new Date())
  const [expires, setExpires] = useState(() => inDays(90))
  const valid = isFutureDay(expires, today)
  if (!editing)
    return (
      <Button size="sm" variant="ghost" onPress={() => setEditing(true)}>
        Renew…
      </Button>
    )
  return (
    <div className="flex items-end gap-1.5">
      <TextField
        label="New last day"
        type="date"
        value={expires}
        onChange={setExpires}
        className="w-40"
        {...(valid ? {} : { error: 'From today on' })}
      />
      <Button
        size="sm"
        variant="primary"
        isDisabled={!valid || renew.isPending}
        onPress={() =>
          renew.mutate(
            {
              settingId: row.settingId,
              advisory: row.entry.id,
              expires,
              ...(row.entry.package ? { package: row.entry.package } : {}),
            },
            {
              onSuccess: () => {
                setEditing(false)
                notify.success('Renewed', `${row.entry.id} until ${expires}`)
              },
              onError: (error) => notify.error('Not renewed', messageOf(error)),
            },
          )
        }
      >
        Renew
      </Button>
      <Button size="sm" variant="ghost" onPress={() => setEditing(false)}>
        Cancel
      </Button>
    </div>
  )
}

function Entries({
  rows,
  people,
  canWrite,
}: {
  rows: readonly AllowlistRow[]
  people: Record<string, { name: string }>
  canWrite: boolean
}) {
  return (
    <Table label="Allowlist entries">
      <thead>
        <tr>
          <Th>Advisory</Th>
          <Th>Package</Th>
          <Th>Applies to</Th>
          <Th>Reason</Th>
          <Th>Last day</Th>
          <Th>Hides now</Th>
          {canWrite ? <Th align="right">Action</Th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <Td className="mono text-[12.5px]">{row.entry.id}</Td>
            <Td className="mono text-[12.5px]">{row.entry.package ?? 'any'}</Td>
            <Td className="text-muted">{describeScope(row.scope)}</Td>
            <Td>
              <span className="flex max-w-md flex-col">
                <span>{row.entry.reason}</span>
                {row.entry.author ? (
                  <span className="text-[11px] text-dim">
                    {people[row.entry.author]?.name ?? row.entry.author}
                  </span>
                ) : null}
              </span>
            </Td>
            <Td className="whitespace-nowrap">
              <Tag tone={stateTone[row.state]} dot>
                {allowlistStateLabel[row.state]}
                {row.entry.expires ? ` · ${formatDate(`${row.entry.expires}T00:00:00Z`)}` : ''}
              </Tag>
            </Td>
            <Td className="text-muted">
              {row.covers.length ? plural(row.covers.length, 'repository', 'repositories') : '—'}
            </Td>
            {canWrite ? (
              <Td align="right">
                <Renew row={row} />
              </Td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

function AllowlistedFindings({ groups }: { groups: readonly FindingGroup[] }) {
  const allowlisted = groups.filter((group) =>
    group.repos.some((repo) => repo.status === 'allowlisted'),
  )
  if (!allowlisted.length) return <EmptyState icon={<ShieldOff />} title="Nothing is allowlisted" />
  return (
    <Table label="Allowlisted findings">
      <thead>
        <tr>
          <Th>Advisory</Th>
          <Th>Package</Th>
          <Th>Repositories</Th>
        </tr>
      </thead>
      <tbody>
        {allowlisted.map((group) => (
          <tr key={findingKey(group)}>
            <Td className="mono text-[12.5px]">{group.advisory}</Td>
            <Td className="mono text-[12.5px]">{group.package}</Td>
            <Td className="mono text-[12.5px] text-muted">
              {group.repos
                .filter((repo) => repo.status === 'allowlisted')
                .map((repo) => repo.repo)
                .join(', ')}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

/**
 * The Allowlist view: every `audit.allowlist` entry with its scope, reason, last day and the
 * repositories it hides a finding in now, expired first; renewing needs `settings:write`.
 * Without `settings:read` the entries stay hidden and the allowlisted findings are listed instead.
 * With `repo`, only entries that hide something there or whose setting scope reaches it are kept,
 * so expired entries for the repository stay listed for renewal.
 */
export function AllowlistView({ repo }: { repo?: RepoRef }) {
  const { can } = useSession()
  const readable = can('settings:read')
  const settings = useSettings(readable)
  const findings = useFindings(repo)
  const repos = useRepos(repo !== undefined)
  const groups = findings.data?.groups ?? []
  if (findings.isPending || (readable && settings.isPending))
    return <Placeholder className="h-48" />
  if (findings.isError) return <ErrorState error={findings.error} />
  if (!readable)
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-panel">
        <p className="px-3.5 pt-3 text-xs text-muted">
          Allowlist entries are settings; reading them needs settings access. These findings are
          allowlisted now.
        </p>
        <AllowlistedFindings groups={groups} />
      </div>
    )
  if (settings.isError) return <ErrorState error={settings.error} />
  const all = allowlistRows(settings.data?.settings ?? [], groups)
  const key = repo ? repoKey(repo) : undefined
  const repoGroups = key
    ? (repos.data?.repos.find((entry) => repoKey(entry.repo) === key)?.groups ??
      groups.flatMap((group) => group.repos).find((entry) => entry.repo === key)?.groups ??
      [])
    : []
  const rows = key
    ? all.filter(
        (row) =>
          row.covers.includes(key) || scopeCovers(row.scope, { repo: key, groups: repoGroups }),
      )
    : all
  const count = (state: AllowlistState) => rows.filter((row) => row.state === state).length
  if (!rows.length)
    return (
      <EmptyState
        icon={<ShieldOff />}
        title="No allowlist entries"
        description="Allowlist a finding from its sheet to stop counting it until a last day."
      />
    )
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <Strip
        cells={[
          { value: rows.length, label: rows.length === 1 ? 'entry' : 'entries' },
          { value: count('expired'), label: 'expired', tone: count('expired') ? 'danger' : 'none' },
          {
            value: count('expiring'),
            label: 'expire within 14 days',
            tone: count('expiring') ? 'warning' : 'none',
          },
          { value: count('permanent'), label: 'without a last day' },
        ]}
      />
      <Entries rows={rows} people={settings.data?.people ?? {}} canWrite={can('settings:write')} />
    </div>
  )
}
