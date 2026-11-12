import type { LinkResponse, UserView } from '@holtkeeper/api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { UserPlus, Users } from 'lucide-react'
import { useState } from 'react'

import { useGroupTitles, useUsers } from '../../api/queries.ts'
import { usePeopleSummary } from '../../api/settings-people.ts'
import { plural } from '../../lib/format.ts'
import { type GroupTitleOf } from '../../lib/group-titles.ts'
import {
  type PeopleFilter,
  type SignInKind,
  type UserStatus,
  defaultPeopleFilter,
  lastSeenLabel,
  matchesPeople,
  scopeLabel,
  signInKindOf,
  signInLabel,
  statusNote,
  teamOptions,
  userStatusLabels,
  userStatusOf,
  userStatusTone,
} from '../../lib/people.ts'
import { roleNames, roleOf } from '../../lib/roles.ts'
import { parseSettingsSearch } from '../../lib/settings-sections.ts'
import { useNow } from '../../lib/use-now.ts'
import {
  Avatar,
  Button,
  EmptyState,
  ErrorState,
  FilterButton,
  Placeholder,
  SearchInput,
  Segmented,
  Strip,
  type StripCell,
  Table,
  Tag,
  Td,
  Th,
  Tr,
} from '../../ui/index.ts'
import { useSectionHeader } from '../settings/section-header.ts'
import { useSession } from '../shell/session.ts'
import { AccessMap } from './AccessMap.tsx'
import { InviteDialog, LinkDialog } from './InviteDialog.tsx'
import { type UserSheetTab, UserSheet, isUserSheetTab } from './UserSheet.tsx'

const roleFilter = (['viewer', 'developer', 'maintainer', 'admin', 'custom'] as const).map(
  (id) => ({ id, label: roleNames[id] }),
)
const signInFilter: { id: SignInKind; label: string }[] = [
  { id: 'passkey', label: 'Passkey' },
  { id: 'sso', label: 'Single sign-on' },
  { id: 'both', label: 'Passkey and SSO' },
  { id: 'none', label: 'Nothing yet' },
]
const statusFilter: { id: UserStatus; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'invited', label: 'Invited' },
  { id: 'disabled', label: 'Disabled' },
]

const appliesTo = (
  user: UserView,
  match: ReturnType<typeof roleOf>,
  titleOf: GroupTitleOf,
): string => {
  if ('scope' in match) return scopeLabel(match.scope, titleOf)
  return user.grants.length ? plural(user.grants.length, 'grant') : 'Nothing'
}

function PeopleStrip() {
  const { can } = useSession()
  const summary = usePeopleSummary(can('users:read'))
  if (!summary.data) return null
  const s = summary.data
  const cells: StripCell[] = [
    { value: s.total, label: s.total === 1 ? 'person' : 'people' },
    { value: s.active, label: 'active', tone: 'success' },
    { value: s.invited, label: 'invited', tone: 'info' },
    { value: s.disabled, label: 'disabled', tone: 'none' },
    { value: s.admins, label: s.admins === 1 ? 'admin' : 'admins' },
    ...(s.withoutSignIn
      ? [{ value: s.withoutSignIn, label: 'without a passkey or SSO', tone: 'warning' as const }]
      : []),
    {
      value: s.signIn.join(', '),
      prefix: 'Sign-in:',
      label: '',
      end: true,
    },
  ]
  return <Strip label="People summary" cells={cells} />
}

/**
 * Settings › People: the strip, filters, a table of everyone the viewer may see (or the access
 * map), a fold for disabled people, the invite dialog and a side sheet per person.
 */
export function People() {
  const titleOf = useGroupTitles()
  const { auth, can, principal } = useSession()
  const enabled = auth.provider === 'users'
  const users = useUsers(enabled && can('users:read'))
  const now = useNow()
  const [filter, setFilter] = useState<PeopleFilter>(defaultPeopleFilter)
  const [view, setView] = useState<'table' | 'map'>('table')
  const search = useSearch({ from: '/app/settings/$section' })
  const navigate = useNavigate()
  const openId = search.item ?? null
  const tab: UserSheetTab = isUserSheetTab(search.tab) ? search.tab : 'role'
  const go = (patch: { item?: string | undefined; tab?: string | undefined }) =>
    void navigate({
      to: '/settings/$section',
      params: { section: 'people' },
      search: (previous) => parseSettingsSearch({ ...previous, ...patch }),
      replace: true,
    })
  const setOpenId = (id: string | null) => go({ item: id ?? undefined, tab: undefined })
  const setTab = (next: UserSheetTab) => go({ tab: next === 'role' ? undefined : next })
  const [inviting, setInviting] = useState(false)
  const [link, setLink] = useState<LinkResponse | null>(null)
  useSectionHeader(
    enabled && can('users:invite')
      ? { primary: { label: 'Invite people', icon: UserPlus, onPress: () => setInviting(true) } }
      : undefined,
  )

  if (!enabled) return null

  const list = users.data?.users ?? []
  const shown = list.filter((user) => matchesPeople(user, filter))
  const disabled = list.filter((user) => user.disabled).length
  const showsDisabled = filter.statuses.length === 0 || filter.statuses.includes('disabled')
  const openIndex = shown.findIndex((user) => user.id === openId)
  const open = list.find((user) => user.id === openId)
  const patch = (next: Partial<PeopleFilter>) => setFilter({ ...filter, ...next })
  const step = (by: number) => {
    const next = shown[openIndex + by]
    return next ? () => setOpenId(next.id) : undefined
  }
  const previous = openIndex > 0 ? step(-1) : undefined
  const next = openIndex >= 0 ? step(1) : undefined

  return (
    <section
      id="users"
      aria-label="Users"
      className="flex flex-col overflow-hidden rounded-xl border border-line"
    >
      <PeopleStrip />
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
        <SearchInput
          aria-label="Search people"
          placeholder="Name, email or team"
          value={filter.query}
          onChange={(query) => patch({ query })}
          className="w-60 max-w-full"
        />
        <FilterButton
          label="Role"
          all="All"
          options={roleFilter}
          value={filter.roles}
          onChange={(roles) => patch({ roles })}
        />
        <FilterButton
          label="Team"
          all="All"
          options={teamOptions(list).map((team) => ({ id: team, label: team }))}
          value={filter.teams}
          onChange={(teams) => patch({ teams })}
        />
        <FilterButton
          label="Sign-in"
          all="All"
          options={signInFilter}
          value={filter.signIn}
          onChange={(signIn) =>
            patch({ signIn: signInFilter.filter((o) => signIn.includes(o.id)).map((o) => o.id) })
          }
        />
        <FilterButton
          label="Status"
          all="All"
          options={statusFilter}
          value={filter.statuses}
          onChange={(statuses) =>
            patch({
              statuses: statusFilter.filter((o) => statuses.includes(o.id)).map((o) => o.id),
            })
          }
        />
        <span className="flex-1" />
        <span className="text-xs text-muted">
          {shown.length} of {list.length} shown
        </span>
        <Segmented
          aria-label="View"
          size="sm"
          options={[
            { id: 'table', label: 'Table' },
            { id: 'map', label: 'Access map' },
          ]}
          value={view}
          onChange={setView}
        />
      </div>

      {users.isPending ? (
        <Placeholder className="m-3.5 h-64" />
      ) : users.isError ? (
        <ErrorState error={users.error} />
      ) : list.length === 0 ? (
        <EmptyState icon={<Users />} title="No people" />
      ) : view === 'map' ? (
        <div className="p-3.5">
          <AccessMap users={shown} onEdit={(user) => setOpenId(user.id)} />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState icon={<Users />} title="Nobody matches these filters" />
      ) : (
        <Table label="People">
          <thead>
            <tr>
              <Th>Person</Th>
              <Th>Teams</Th>
              <Th>Role</Th>
              <Th>Applies to</Th>
              <Th>Last seen</Th>
              <Th>Sign-in</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((user) => {
              const status = userStatusOf(user)
              const note = statusNote(user, now)
              const match = roleOf(user.grants)
              return (
                <Tr
                  key={user.id}
                  selected={user.id === openId}
                  className={user.disabled ? 'opacity-60' : ''}
                  onClick={() => setOpenId(user.id)}
                >
                  <Td>
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Avatar src={user.avatarUrl} name={user.name} size="xs" />
                      <span className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate font-medium">{user.name}</span>
                          {user.id === principal.id ? <Tag>you</Tag> : null}
                        </span>
                        <span className="mono truncate text-xs text-muted">{user.email ?? ''}</span>
                      </span>
                    </span>
                  </Td>
                  <Td className="text-muted">{(user.teams ?? []).join(', ') || '—'}</Td>
                  <Td>{roleNames[match.role]}</Td>
                  <Td className="text-muted">{appliesTo(user, match, titleOf)}</Td>
                  <Td className="whitespace-nowrap text-muted">{lastSeenLabel(user, now)}</Td>
                  <Td
                    className={`whitespace-nowrap ${signInKindOf(user) === 'none' ? 'text-warning' : ''}`}
                  >
                    {signInLabel(user)}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <Tag tone={userStatusTone[status]} dot>
                      {userStatusLabels[status]}
                    </Tag>
                    {note ? <div className="mt-0.5 text-[11px] text-dim">{note}</div> : null}
                  </Td>
                </Tr>
              )
            })}
          </tbody>
        </Table>
      )}

      <footer className="flex flex-wrap items-center gap-2 border-t border-line px-3.5 py-2.5 text-xs">
        {disabled && !showsDisabled ? (
          <Button
            variant="ghost"
            size="sm"
            onPress={() => patch({ statuses: [...filter.statuses, 'disabled'] })}
          >
            Disabled · {plural(disabled, 'person', 'people')}
          </Button>
        ) : null}
        <span className="flex-1" />
        <span className="text-muted">Invite links work once and expire.</span>
      </footer>

      {open ? (
        <UserSheet
          user={open}
          tab={tab}
          onTab={setTab}
          onClose={() => setOpenId(null)}
          onLink={setLink}
          {...(openIndex >= 0 ? { index: openIndex, total: shown.length } : {})}
          {...(previous ? { onPrevious: previous } : {})}
          {...(next ? { onNext: next } : {})}
        />
      ) : null}
      {inviting ? <InviteDialog onClose={() => setInviting(false)} onLink={setLink} /> : null}
      {link ? <LinkDialog link={link} onClose={() => setLink(null)} /> : null}
    </section>
  )
}
