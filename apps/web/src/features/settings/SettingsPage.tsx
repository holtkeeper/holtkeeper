import { Navigate, useNavigate, useParams } from '@tanstack/react-router'
import { type ComponentType, type ReactNode, useMemo, useState } from 'react'

import {
  useAiOverview,
  useCredentials,
  useMe,
  useRepos,
  useSettings,
  useUsers,
} from '../../api/queries.ts'
import { canReadSpend, settingsSectionRequires, visibleSettingsSections } from '../../lib/access.ts'
import { hubSearch } from '../../lib/repo-page.ts'
import { parseRepoKey, repoKey, repoSplat } from '../../lib/repo.ts'
import {
  budgetMeta,
  credentialsNeedingAttention,
  instanceLine,
} from '../../lib/settings-counters.ts'
import { groupSettingsResults, searchSettings, settingsIndex } from '../../lib/settings-search.ts'
import {
  type SettingsSectionId,
  parseSettingsSection,
  settingsSections,
} from '../../lib/settings-sections.ts'
import type { SubNavItem } from '../../ui/index.ts'
import { Page, Select, SubNav, buttonClass } from '../../ui/index.ts'
import { AuditLogPage } from '../audit-log/AuditLogPage.tsx'
import { Forbidden } from '../shell/Forbidden.tsx'
import { navLink, visibleNav } from '../shell/nav.ts'
import { NotFound } from '../shell/NotFound.tsx'
import { useSession } from '../shell/session.ts'
import { type SectionHeader, SectionHeaderContext } from './section-header.ts'
import { AiSection } from './sections/AiSection.tsx'
import { AnalyzersSection } from './sections/AnalyzersSection.tsx'
import { IntegrationsSection } from './sections/IntegrationsSection.tsx'
import { PeopleSection } from './sections/PeopleSection.tsx'
import { PoliciesSection } from './sections/PoliciesSection.tsx'
import { SystemSection } from './sections/SystemSection.tsx'

const sectionBodies: Record<Exclude<SettingsSectionId, 'audit'>, ComponentType> = {
  people: PeopleSection,
  ai: AiSection,
  integrations: IntegrationsSection,
  analyzers: AnalyzersSection,
  policies: PoliciesSection,
  system: SystemSection,
}

/** Anchors of each section's blocks, as the header's in-page tabs. */
const sectionAnchors: Partial<Record<SettingsSectionId, readonly { id: string; label: string }[]>> =
  {
    people: [
      { id: 'users', label: 'Users' },
      { id: 'roles', label: 'Roles' },
      { id: 'reach', label: 'Reach' },
    ],
    ai: [
      { id: 'providers', label: 'Providers' },
      { id: 'budgets', label: 'Budgets' },
      { id: 'tools', label: 'Agent tools' },
    ],
    integrations: [
      { id: 'forges', label: 'Forges' },
      { id: 'credentials', label: 'Credentials' },
      { id: 'trackers', label: 'Trackers' },
      { id: 'limits', label: 'Request limits' },
    ],
    system: [
      { id: 'storage', label: 'Storage' },
      { id: 'caches', label: 'Caches' },
      { id: 'database', label: 'Database' },
      { id: 'library-index', label: 'Library index' },
      { id: 'background', label: 'Background work' },
      { id: 'advanced', label: 'All keys' },
    ],
  }

function Anchors({ section }: { section: SettingsSectionId }) {
  const anchors = sectionAnchors[section]
  if (!anchors) return null
  return (
    <nav aria-label="On this page" className="flex flex-wrap items-center gap-0.5">
      {anchors.map((anchor) => (
        <a key={anchor.id} href={`#${anchor.id}`} className={buttonClass('ghost', 'sm')}>
          {anchor.label}
        </a>
      ))}
    </nav>
  )
}

/** A repository picker that opens the hub's Settings tab: the effective config for one repository. */
function EffectiveConfigFor() {
  const { can } = useSession()
  const repos = useRepos(can('settings:read'))
  const navigate = useNavigate()
  const keys = (repos.data?.repos ?? []).map((summary) => repoKey(summary.repo)).toSorted()
  if (!keys.length) return null
  return (
    <Select
      aria-label="Effective config for a repository"
      placeholder="Effective config for…"
      options={keys.map((key) => ({ id: key, label: key }))}
      value={undefined}
      onChange={(key) => {
        const repo = parseRepoKey(key)
        if (repo)
          void navigate({
            to: '/repos/$',
            params: { _splat: repoSplat(repo) },
            search: hubSearch('settings'),
          })
      }}
    />
  )
}

function Attention({ count }: { count: number }) {
  return (
    <span className="flex items-center gap-1" aria-label={`${count} need attention`}>
      <span className="size-1.5 rounded-full bg-danger" aria-hidden="true" />
      {count}
    </span>
  )
}

/**
 * What the sub-navigation shows next to a section, from endpoints the shell already reads: the
 * number of people, the share of the weekly AI budget spent, credentials that need attention.
 * Each is read only when the viewer may read it.
 */
function useSectionMeta(): Partial<Record<SettingsSectionId, ReactNode>> {
  const { auth, can } = useSession()
  const users = useUsers(auth.provider === 'users' && can('users:read'))
  const overview = useAiOverview(canReadSpend(can))
  const credentials = useCredentials(can('credentials:read'))
  const attention = credentials.data
    ? credentialsNeedingAttention(credentials.data.credentials, new Date())
    : 0
  return {
    ...(users.data && { people: users.data.users.length }),
    ...(overview.data && { ai: budgetMeta(overview.data.budgets) }),
    ...(attention > 0 && { integrations: <Attention count={attention} /> }),
  }
}

/** The Settings sub-navigation: the sections the viewer may open and a search over every setting. */
function SettingsSubNav({ selected }: { selected: SettingsSectionId }) {
  const { principal, crossTeam, can } = useSession()
  const [query, setQuery] = useState('')
  const settings = useSettings(can('settings:read'))
  const me = useMe()
  const meta = useSectionMeta()
  const items = visibleNav(principal, crossTeam).flatMap((item): SubNavItem[] => {
    if (!item.section) return []
    const extra = meta[item.section]
    return [
      {
        id: item.section,
        label: item.label,
        icon: item.icon,
        link: navLink(item),
        ...(extra !== undefined && { meta: extra }),
      },
    ]
  })
  const instance = me.data ? instanceLine(me.data, window.location.origin) : undefined
  const index = useMemo(
    () => settingsIndex(settings.data?.definitions ?? [], visibleSettingsSections(principal)),
    [settings.data, principal],
  )
  const results = groupSettingsResults(searchSettings(index, query)).map((group) => ({
    label: group.group,
    results: group.entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      detail: entry.kind === 'setting' ? entry.where : entry.description,
      link: entry.link,
    })),
  }))
  return (
    <SubNav
      aria-label="Settings sections"
      heading="Organization"
      items={items}
      selected={selected}
      search={{ 'aria-label': 'Search settings', value: query, onChange: setQuery, results }}
      footer={
        <>
          <span className="text-[11px] font-medium">Look up</span>
          <EffectiveConfigFor />
          <span>Changes here are recorded in the Audit log.</span>
          {instance ? <span className="font-mono">{instance}</span> : null}
        </>
      }
    />
  )
}

function SettingsLayout({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-1 flex-col md:flex-row">{children}</div>
}

/**
 * `/settings/$section`: the Settings sub-navigation on the left (People & access, AI,
 * Integrations, Analyzers, Policies, System, Audit log, each only for principals the server lets
 * read some of it, plus a search over every setting) and the section body from `sections/` on
 * the right. Analyzers and Policies are a second way into settings their pages own. Each
 * section's header has its in-page anchors and the one primary its body asks for through
 * `useSectionHeader`; the sub-navigation's footer opens the effective config of one repository.
 */
export function SettingsPage() {
  const { principal } = useSession()
  const params = useParams({ from: '/app/settings/$section' })
  const section = parseSettingsSection(params.section)
  const visible = visibleSettingsSections(principal)
  if (!section) return <NotFound />
  if (!visible.includes(section))
    return (
      <Page crumbs={[{ label: 'Settings' }]} title="Settings" tabs={false}>
        <Forbidden missing={{ action: settingsSectionRequires[section] }} />
      </Page>
    )
  if (section === 'audit')
    return (
      <SettingsLayout>
        <SettingsSubNav selected={section} />
        <AuditLogPage />
      </SettingsLayout>
    )
  return <SectionPage key={section} section={section} />
}

function SectionPage({ section }: { section: Exclude<SettingsSectionId, 'audit'> }) {
  const [header, setHeader] = useState<SectionHeader>()
  const Body = sectionBodies[section]
  const { label, description } = settingsSections[section]
  return (
    <SettingsLayout>
      <SettingsSubNav selected={section} />
      <Page
        title={label}
        crumbs={[{ label }]}
        description={description}
        tabs={false}
        actions={<Anchors section={section} />}
        {...(header?.primary && { primary: header.primary })}
        {...(header?.more && { more: header.more })}
      >
        <SectionHeaderContext value={setHeader}>
          <div className="flex flex-col gap-8">
            <Body />
          </div>
        </SectionHeaderContext>
      </Page>
    </SettingsLayout>
  )
}

/** `/settings`: opens the first section the viewer may see, or says there is none. */
export function SettingsHome() {
  const { principal } = useSession()
  const [first] = visibleSettingsSections(principal)
  if (!first)
    return (
      <Page crumbs={[{ label: 'Settings' }]} title="Settings" tabs={false}>
        <Forbidden missing={{ action: settingsSectionRequires.audit }} />
      </Page>
    )
  return <Navigate to="/settings/$section" params={{ section: first }} replace />
}
