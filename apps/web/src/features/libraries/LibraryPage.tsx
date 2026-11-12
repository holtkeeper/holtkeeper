import type { DependencyDetail } from '@holtkeeper/api'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { Rocket } from 'lucide-react'
import { useState } from 'react'

import { useDependency, useDependencyApi } from '../../api/queries.ts'
import {
  type LibrarySearch,
  libraryTabs,
  parseLibraryKey,
  parseLibraryTab,
  upgradeVersions,
} from '../../lib/dependencies.ts'
import { formatRef, formatRelative } from '../../lib/format.ts'
import { documentedShare } from '../../lib/public-api.ts'
import { repoKey } from '../../lib/repo.ts'
import { pageSettingKeys } from '../../lib/settings-sections.ts'
import {
  type Crumb,
  EmptyState,
  Page,
  Strip,
  type StripCell,
  Tag,
  UnderlineTabs,
} from '../../ui/index.ts'
import { useConfigure } from '../settings/SettingsSheet.tsx'
import { useSession } from '../shell/session.ts'
import { LibraryDetail, type LibraryState } from './LibraryDetail.tsx'
import { RollOutDialog } from './RollOut.tsx'

type Library = { ecosystem: DependencyDetail['ecosystem']; name: string }

function useFacts(library: Library, detail: DependencyDetail | undefined): StripCell[] {
  const api = useDependencyApi(library)
  if (!detail) return []
  const share = api.data?.api
    ? documentedShare(api.data.api.documented, api.data.api.exports)
    : undefined
  const definedIn = api.data?.definedIn
  return [
    {
      prefix: 'Latest',
      value: <span className="mono">{detail.latest ?? '—'}</span>,
      label: '',
      ...(detail.latestCheckedAt
        ? { caption: `· checked ${formatRelative(detail.latestCheckedAt)}` }
        : {}),
    },
    ...(definedIn
      ? [
          {
            prefix: 'Source',
            value: <span className="mono">{repoKey(definedIn.repo)}</span>,
            label: '',
            ...(definedIn.ref ? { caption: formatRef(definedIn.ref) } : {}),
          },
        ]
      : []),
    ...(api.data?.api
      ? [
          {
            value: api.data.api.exports,
            label: 'exports',
            ...(share !== undefined ? { caption: `· ${share}% documented` } : {}),
          },
        ]
      : []),
    {
      value: detail.usedBy.length,
      label: detail.usedBy.length === 1 ? 'repository' : 'repositories',
    },
    ...(detail.advisories.length
      ? [{ value: detail.advisories.length, label: 'advisories', tone: 'danger' as const }]
      : []),
  ]
}

/** One library on its own page, `/supply/libraries/<ecosystem>/<name>`, with all six tabs. */
export function LibraryPage() {
  const { ecosystem, _splat: name } = useParams({ strict: false })
  const library = parseLibraryKey(`${ecosystem ?? ''}:${name ?? ''}`)
  const back: Crumb = { label: 'Libraries', link: { to: '/supply/libraries', search: {} } }
  if (!library)
    return (
      <Page title="Unknown library" crumbs={[back, { label: 'Unknown library' }]}>
        <EmptyState title="No such library" description="Ecosystems are npm and Go." />
      </Page>
    )
  return <KnownLibrary key={`${library.ecosystem}:${library.name}`} library={library} back={back} />
}

function KnownLibrary({ library, back }: { library: Library; back: Crumb }) {
  const search: LibrarySearch = useSearch({ strict: false })
  const navigate = useNavigate()
  const { can } = useSession()
  const detail = useDependency(library)
  const [rolling, setRolling] = useState(false)
  const { configure, sheet } = useConfigure('Libraries settings', pageSettingKeys.dependencies)
  const tab = parseLibraryTab(search.tab)
  const { tab: _tab, ...state } = search
  const facts = useFacts(library, detail.data)
  const go = (next: LibrarySearch) =>
    void navigate({
      to: '/supply/libraries/$ecosystem/$',
      params: { ecosystem: library.ecosystem, _splat: library.name },
      search: next,
      replace: true,
    })
  const onState = (next: LibraryState) => {
    const clean = Object.fromEntries(
      Object.entries(next).filter(([, value]) => value !== undefined && value !== ''),
    )
    go({ ...clean, ...(tab !== 'overview' ? { tab } : {}) })
  }
  const data = detail.data
  const to = search.to ?? data?.latest ?? (data ? upgradeVersions(data).to[0] : undefined)
  const behind = data?.usedBy.filter((user) => !to || !user.versions.includes(to)).length ?? 0
  const ends = { ...(search.from ? { from: search.from } : {}), ...(to ? { to } : {}) }

  return (
    <Page
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="mono">{library.name}</span>
          {data?.internal ? <Tag tone="accent">internal</Tag> : null}
          <Tag mono>{library.ecosystem}</Tag>
        </span>
      }
      {...(data?.description ? { description: data.description } : {})}
      crumbs={[back, { label: <span className="mono">{library.name}</span> }]}
      tabs={false}
      {...(configure ? { configure } : {})}
      {...(data && to && can('tasks:run')
        ? {
            primary: {
              label: `Roll out ${to}`,
              icon: Rocket,
              isDisabled: behind === 0,
              onPress: () => setRolling(true),
            },
          }
        : {})}
    >
      {facts.length ? <Strip cells={facts} label="Library facts" className="-mx-4 -mt-4" /> : null}
      <UnderlineTabs
        items={libraryTabs.map((item) => {
          const badge =
            item.id === 'used-by' ? data?.usedBy.length : item.id === 'upgrade' ? behind : 0
          return { id: item.id, label: item.label, badge: badge || undefined }
        })}
        selected={tab}
        onSelect={(next) => {
          const nextTab = parseLibraryTab(next)
          go({ ...state, ...(nextTab !== 'overview' ? { tab: nextTab } : {}) })
        }}
        aria-label="Library views"
        className={`-mx-4 ${facts.length ? '-mt-5' : '-mt-4'}`}
      />
      <LibraryDetail library={library} tab={tab} state={state} onState={onState} />
      {data ? (
        <RollOutDialog detail={data} ends={ends} open={rolling} onOpenChange={setRolling} />
      ) : null}
      {sheet}
    </Page>
  )
}
