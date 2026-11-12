import type { RepoRef } from '@holtkeeper/api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useState } from 'react'

import { useFindings, useSettings } from '../../api/queries.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { type SecuritySearch, allowlistRows } from '../../lib/security.ts'
import { pageSettingKeys } from '../../lib/settings-sections.ts'
import { Button, Notice, Page, UnderlineTabs } from '../../ui/index.ts'
import { useRunJob } from '../jobs/RunJobDialog.tsx'
import { useConfigure } from '../settings/SettingsSheet.tsx'
import { useSession } from '../shell/session.ts'
import { AllowlistView } from './AllowlistView.tsx'
import { FindingsBody } from './Findings.tsx'
import { RunsView } from './RunsView.tsx'

type View = 'findings' | 'runs' | 'allowlist'

function ExpiredNotice({ onReview }: { onReview: () => void }) {
  const { can } = useSession()
  const settings = useSettings(can('settings:read'))
  const findings = useFindings()
  if (!settings.data || !findings.data) return null
  const expired = allowlistRows(settings.data.settings, findings.data.groups).filter(
    (row) => row.state === 'expired',
  )
  if (!expired.length) return null
  return (
    <Notice
      tone="warning"
      title={`${expired.length} allowlist ${expired.length === 1 ? 'entry has' : 'entries have'} expired`}
    >
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        Their findings count as open again:{' '}
        <span className="mono">
          {expired
            .slice(0, 3)
            .map((row) => `${row.entry.id}${row.entry.package ? ` in ${row.entry.package}` : ''}`)
            .join(', ')}
          {expired.length > 3 ? ` +${expired.length - 3}` : ''}
        </span>
        <Button size="sm" variant="ghost" onPress={onReview}>
          Review in Allowlist
        </Button>
      </span>
    </Notice>
  )
}

function Views({
  repo,
  search,
  update,
  notice,
}: {
  repo?: RepoRef
  search: SecuritySearch
  update: (patch: Partial<SecuritySearch>) => void
  notice?: boolean
}) {
  const { can } = useSession()
  const findings = useFindings(repo)
  const settings = useSettings(can('settings:read'))
  const view: View = search.view ?? 'findings'
  const total = findings.data?.groups.length
  const allowlisted =
    settings.data && findings.data
      ? allowlistRows(settings.data.settings, findings.data.groups).length
      : undefined
  return (
    <div className="flex flex-col gap-3">
      <UnderlineTabs
        aria-label="Security views"
        items={[
          {
            id: 'findings',
            label: 'Findings',
            ...(total !== undefined ? { badge: total } : {}),
          },
          { id: 'runs', label: 'Runs' },
          {
            id: 'allowlist',
            label: 'Allowlist',
            ...(allowlisted !== undefined ? { badge: allowlisted } : {}),
          },
        ]}
        selected={view}
        onSelect={(id) =>
          update({
            view: id === 'runs' || id === 'allowlist' ? id : undefined,
            finding: undefined,
            tab: undefined,
          })
        }
      />
      {view === 'findings' ? (
        <>
          {notice ? <ExpiredNotice onReview={() => update({ view: 'allowlist' })} /> : null}
          <FindingsBody
            {...(repo ? { repo } : {})}
            search={search}
            update={update}
            pickRepo={notice === true}
          />
        </>
      ) : view === 'runs' ? (
        <RunsView {...(repo ? { repo } : {})} search={search} update={update} />
      ) : (
        <AllowlistView {...(repo ? { repo } : {})} />
      )}
    </div>
  )
}

/**
 * Supply › Security: findings of the newest audit of every readable repository grouped by
 * advisory and package, audit runs and the allowlist, as views kept in `?view=`. `?repo=`
 * narrows every view to one repository.
 */
export function SecurityPage() {
  const search = useSearch({ from: '/app/supply/security' })
  const navigate = useNavigate({ from: '/supply/security' })
  const repo = parseRepoKey(search.repo)
  const update = (patch: Partial<SecuritySearch>) =>
    void navigate({
      search: (prev) =>
        Object.fromEntries(
          Object.entries({ ...prev, ...patch }).filter(([, value]) => value !== undefined),
        ),
      replace: true,
    })
  const settings = useConfigure('Security settings', pageSettingKeys.audits)
  const run = useRunJob({ analyzer: 'audit', label: 'Run audit', ...(repo ? { repo } : {}) })

  return (
    <Page
      crumbs={[{ label: 'Security' }]}
      description={
        repo
          ? `Findings, audit runs and allowlist of ${repoKey(repo)}`
          : 'Findings of the newest audit of every repository you can see'
      }
      search={{
        value: search.q ?? '',
        onChange: (q) => update({ q: q || undefined }),
        'aria-label': 'Filter findings',
        placeholder: 'Advisory, CVE, package or repository',
      }}
      configure={settings.configure}
      primary={run.action}
    >
      <Views {...(repo ? { repo } : {})} search={search} update={update} notice />
      {settings.sheet}
      {run.dialog}
    </Page>
  )
}

/** The Security body narrowed to one repository, for the repository hub's Supply chain tab. */
export function RepoSecurity({ repo }: { repo: RepoRef }) {
  const [search, setSearch] = useState<SecuritySearch>({})
  const update = (patch: Partial<SecuritySearch>) =>
    setSearch((prev) =>
      Object.fromEntries(
        Object.entries({ ...prev, ...patch }).filter(([, value]) => value !== undefined),
      ),
    )
  return <Views repo={repo} search={search} update={update} />
}
