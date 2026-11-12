import type { Grant, LinkResponse, Scope, UserView } from '@holtkeeper/api'
import { Fingerprint, KeyRound, LifeBuoy, Mail, Pencil, Power, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useGroupNames, useGroupTitles, useHistory, useUserMutations } from '../../api/queries.ts'
import { useResendInvite } from '../../api/settings-people.ts'
import { actionLabel, outcomeLabel, outcomeTone, targetLabel } from '../../lib/audit-log.ts'
import { formatDate, formatDateTime, formatRelative, plural, shortId } from '../../lib/format.ts'
import {
  lastSeenLabel,
  signInLabel,
  statusNote,
  userStatusLabels,
  userStatusOf,
  userStatusTone,
} from '../../lib/people.ts'
import {
  type AbilityState,
  type RoleId,
  abilityChanges,
  grantsForRole,
  roleNames,
  roleOf,
  sameAccess,
} from '../../lib/roles.ts'
import { isEmptyScope, normalizeScope } from '../../lib/scope.ts'
import { useNow } from '../../lib/use-now.ts'
import {
  Avatar,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  GroupName,
  KeyValue,
  LoadMore,
  Notice,
  notify,
  Placeholder,
  quietActionsOf,
  SideSheet,
  Tag,
  TextField,
  Tooltip,
} from '../../ui/index.ts'
import { GrantsEditor } from '../access/GrantsEditor.tsx'
import { ScopeBadge, ScopeEditor } from '../access/ScopeEditor.tsx'
import { useSession } from '../shell/session.ts'
import { RolePicker } from './RolePicker.tsx'

const sheetTabs = ['role', 'sign-in', 'teams', 'activity'] as const

export type UserSheetTab = (typeof sheetTabs)[number]

/** Whether `value` names a tab of the user sheet. */
export const isUserSheetTab = (value: unknown): value is UserSheetTab =>
  sheetTabs.some((tab) => tab === value)

const abilityText: Readonly<Record<AbilityState, { label: string; className: string }>> = {
  allowed: { label: 'Allowed', className: 'text-foreground' },
  gains: { label: 'Gains', className: 'text-ok' },
  loses: { label: 'Loses', className: 'text-bad' },
  no: { label: 'Not allowed', className: 'text-dim' },
}

function RoleTab({ user, canEdit }: { user: UserView; canEdit: boolean }) {
  const match = roleOf(user.grants)
  const groups = useGroupNames()
  const { update } = useUserMutations()
  const [role, setRole] = useState<RoleId>(match.role)
  const [scope, setScope] = useState<Scope>('scope' in match ? match.scope : { groups: [] })
  const [exact, setExact] = useState<Grant[] | null>(null)
  const draft: Grant[] =
    exact ?? (role === 'custom' || role === 'none' ? user.grants : grantsForRole(role, scope))
  const changed = !sameAccess(draft, user.grants)
  const problem = draft.some((grant) => grant.actions.length === 0 || isEmptyScope(grant.scope))
  const first = user.name.split(/\s+/)[0] ?? user.name
  const gained = abilityChanges(user.grants, draft).filter((row) => row.state === 'gains').length

  const discard = () => {
    setRole(match.role)
    setScope('scope' in match ? match.scope : { groups: [] })
    setExact(null)
  }
  const save = () =>
    update.mutate(
      {
        id: user.id,
        input: { grants: draft.map((g) => ({ ...g, scope: normalizeScope(g.scope) })) },
      },
      {
        onSuccess: () => {
          notify.success('Access saved', user.name)
          setExact(null)
        },
        onError: (error) => notify.error('Not saved', messageOf(error)),
      },
    )

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Role</h3>
          <span className="flex-1" />
          {changed ? <Tag tone="warning">Unsaved change</Tag> : null}
        </div>
        {match.role === 'custom' && exact === null && role === 'custom' ? (
          <Notice tone="accent" title="Custom grants">
            These grants match no role. They stay exactly as they are unless you pick a role or edit
            the grants.
          </Notice>
        ) : null}
        {exact === null ? (
          <RolePicker
            label={`Role of ${user.name}`}
            value={role}
            current={match.role}
            onChange={(next) => {
              setRole(next)
              if (role === 'custom' || role === 'none') setScope({ groups: [] })
            }}
            isDisabled={!canEdit}
          />
        ) : null}
      </section>

      {exact === null && role !== 'admin' && role !== 'custom' && role !== 'none' ? (
        <section className="flex flex-col gap-2">
          {canEdit ? (
            <ScopeEditor value={scope} onChange={setScope} groups={groups} label="Applies to" />
          ) : (
            <>
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Applies to</h3>
              <ScopeBadge scope={scope} />
            </>
          )}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
            What {first} can do
          </h3>
          <span className="flex-1" />
          {gained ? (
            <span className="text-xs text-ok">{plural(gained, 'ability', 'abilities')} gained</span>
          ) : null}
        </div>
        <ul aria-label={`Abilities of ${user.name}`} className="flex flex-col">
          {abilityChanges(user.grants, draft).map(({ ability, state }, index, rows) => (
            <li
              key={ability.label}
              className="grid grid-cols-[96px_minmax(0,1fr)_auto] items-baseline gap-2 border-b border-line py-1.5 text-[12.5px] last:border-b-0"
            >
              <span className="text-xs text-dim">
                {rows[index - 1]?.ability.area === ability.area ? '' : ability.area}
              </span>
              <span className={state === 'no' ? 'text-muted' : ''}>{ability.label}</span>
              <span className={`text-xs ${abilityText[state].className}`}>
                {abilityText[state].label}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <details className="group flex flex-col gap-2" open={exact !== null}>
        <summary className="cursor-pointer text-xs text-muted hover:text-foreground">
          Grants and action ids · {plural(user.grants.length, 'grant')}
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          {exact === null ? (
            <>
              {user.grants.map((grant, i) => (
                <div key={i} className="flex flex-col gap-1 rounded-lg border border-line p-2">
                  <ScopeBadge scope={grant.scope} />
                  <span className="mono text-[11.5px] text-muted">{grant.actions.join(', ')}</span>
                </div>
              ))}
              {canEdit ? (
                <Button size="sm" variant="ghost" onPress={() => setExact(user.grants)}>
                  Edit exact grants
                </Button>
              ) : null}
            </>
          ) : (
            <GrantsEditor value={exact} onChange={setExact} groups={groups} />
          )}
        </div>
      </details>

      <p className="text-xs text-muted">
        You can only give access you have yourself. Changing access signs {first} out everywhere.
      </p>

      {canEdit ? (
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" size="sm" isDisabled={!changed} onPress={discard}>
            Discard
          </Button>
          <Button
            variant="secondary"
            size="sm"
            isDisabled={!changed || problem}
            isPending={update.isPending}
            onPress={save}
          >
            Save access
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function SignInTab({ user, canEdit }: { user: UserView; canEdit: boolean }) {
  const { removePasskey } = useUserMutations()
  const [removing, setRemoving] = useState<{ id: string; label: string } | null>(null)
  const now = useNow()
  if (user.passkeys.length === 0 && user.identities.length === 0)
    return (
      <EmptyState
        icon={<KeyRound />}
        title="No passkey or single sign-on yet"
        description={
          user.invite
            ? 'They sign in once they open their invite link.'
            : 'Create a recovery link so they can add a passkey.'
        }
      />
    )
  return (
    <>
      <ul aria-label={`Sign-in methods of ${user.name}`} className="flex flex-col">
        {user.passkeys.map((key) => (
          <li
            key={key.id}
            className="flex items-center gap-2 border-b border-line py-2 last:border-b-0"
          >
            <Fingerprint className="size-4 text-muted" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[12.5px]">Passkey · {key.label ?? 'Unnamed'}</span>
              <span className="text-xs text-muted">
                {key.lastUsedAt ? `Used ${formatRelative(key.lastUsedAt, now)}` : 'Never used'} ·
                added {formatDate(key.createdAt)}
              </span>
            </span>
            {canEdit ? (
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label={`Remove passkey ${key.label ?? key.id}`}
                onPress={() => setRemoving({ id: key.id, label: key.label ?? 'Passkey' })}
              >
                <Trash2 className="size-3.5" />
              </Button>
            ) : null}
          </li>
        ))}
        {user.identities.map((identity) => (
          <li
            key={`${identity.provider}-${identity.email ?? ''}`}
            className="flex items-center gap-2 border-b border-line py-2 last:border-b-0"
          >
            <KeyRound className="size-4 text-muted" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[12.5px]">
                SSO · <span className="mono">{identity.provider}</span>
              </span>
              {identity.email ? (
                <span className="mono text-xs text-muted">{identity.email}</span>
              ) : null}
            </span>
            <Tag tone="success" dot>
              Linked
            </Tag>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        isOpen={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove passkey “${removing?.label ?? ''}”?`}
        confirmLabel="Remove"
        isPending={removePasskey.isPending}
        onConfirm={() =>
          removing &&
          removePasskey.mutate(
            { userId: user.id, passkeyId: removing.id },
            {
              onSuccess: () => {
                notify.success('Passkey removed')
                setRemoving(null)
              },
              onError: (error) => notify.error('Not removed', messageOf(error)),
            },
          )
        }
      >
        {user.name} can no longer sign in with it.
      </ConfirmDialog>
    </>
  )
}

function TeamsTab({ user }: { user: UserView }) {
  const titleOf = useGroupTitles()
  const teams = user.teams ?? []
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        Their home groups, else the groups their grants name. Teams decide what “My teams” shows
        them; access comes only from grants.
      </p>
      {teams.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={`Teams of ${user.name}`}>
          {teams.map((team) => (
            <li key={team}>
              <Tag>{titleOf(team)}</Tag>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-muted">No team: their grants name no group.</p>
      )}
    </div>
  )
}

function ActivityTab({ user }: { user: UserView }) {
  const history = useHistory({ actor: user.id }, true, 25)
  const now = useNow()
  const events = history.data?.pages.flatMap((page) => page.events) ?? []
  return (
    <div className="flex flex-col gap-3">
      <KeyValue
        rows={[
          { label: 'Last seen', value: lastSeenLabel(user, now) },
          { label: 'Added', value: formatDate(user.createdAt) },
        ]}
      />
      {history.isPending ? (
        <Placeholder className="h-40" />
      ) : history.isError ? (
        <ErrorState error={history.error} />
      ) : events.length === 0 ? (
        <p className="text-[12.5px] text-muted">Nothing you can see in the audit log yet.</p>
      ) : (
        <ul aria-label={`Activity of ${user.name}`} className="flex flex-col">
          {events.map((event) => (
            <li
              key={event.id}
              className="flex items-baseline gap-2 border-b border-line py-1.5 text-[12.5px] last:border-b-0"
            >
              <Tooltip content={formatDateTime(event.at)}>
                <time tabIndex={0} dateTime={event.at} className="w-24 shrink-0 text-xs text-muted">
                  {formatRelative(event.at, now)}
                </time>
              </Tooltip>
              <span className="min-w-0 flex-1">
                <span>{actionLabel(event.action)}</span>
                <span className="mono ml-1.5 text-xs text-muted">{targetLabel(event.target)}</span>
              </span>
              {event.outcome !== 'ok' ? (
                <Tag tone={outcomeTone(event.outcome)}>{outcomeLabel(event.outcome)}</Tag>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {history.hasNextPage ? (
        <LoadMore
          onLoad={() => void history.fetchNextPage()}
          isPending={history.isFetchingNextPage}
        >
          Older
        </LoadMore>
      ) : null}
    </div>
  )
}

function EditProfileDialog({ user, onClose }: { user: UserView; onClose: () => void }) {
  const [name, setName] = useState(user.name)
  const [email, setEmail] = useState(user.email ?? '')
  const { update } = useUserMutations()
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={`Edit ${user.name}`}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            isDisabled={!name.trim()}
            isPending={update.isPending}
            onPress={() =>
              update.mutate(
                {
                  id: user.id,
                  input: { name: name.trim(), ...(email.trim() ? { email: email.trim() } : {}) },
                },
                { onSuccess: onClose },
              )
            }
          >
            Save
          </Button>
        </>
      }
    >
      {update.error ? (
        <Notice tone="danger" title="Not saved">
          {messageOf(update.error)}
        </Notice>
      ) : null}
      <TextField label="Name" value={name} onChange={setName} isRequired autoFocus />
      <TextField label="Email" type="email" value={email} onChange={setEmail} />
    </Dialog>
  )
}

/**
 * One person as a side sheet over the People table: status, teams and who added them, quiet
 * actions (recovery or a new invite, disable), and Role, Sign-in, Teams and Activity tabs.
 */
export function UserSheet({
  user,
  tab,
  onTab,
  onClose,
  onLink,
  ...position
}: {
  user: UserView
  tab: UserSheetTab
  onTab: (tab: UserSheetTab) => void
  onClose: () => void
  onLink: (link: LinkResponse) => void
  index?: number
  total?: number
  onPrevious?: () => void
  onNext?: () => void
}) {
  const { can, principal } = useSession()
  const now = useNow()
  const { update, recovery } = useUserMutations()
  const resend = useResendInvite()
  const [editing, setEditing] = useState(false)
  const [disabling, setDisabling] = useState(false)
  const self = user.id === principal.id
  const canWrite = can('users:write')
  const status = userStatusOf(user)
  const note = statusNote(user, now)
  const signInCount = user.passkeys.length + user.identities.length

  const linkAction = user.invite
    ? can('users:invite')
      ? {
          label: 'Send a new invite',
          icon: Mail,
          onPress: () =>
            resend.mutate(user.id, {
              onSuccess: onLink,
              onError: (error) => notify.error('No link created', messageOf(error)),
            }),
        }
      : undefined
    : canWrite
      ? {
          label: 'Create recovery link',
          icon: LifeBuoy,
          onPress: () =>
            recovery.mutate(user.id, {
              onSuccess: onLink,
              onError: (error) => notify.error('No link created', messageOf(error)),
            }),
        }
      : undefined
  const toggle =
    canWrite && !self
      ? {
          label: user.disabled ? 'Enable' : 'Disable',
          icon: Power,
          onPress: () =>
            user.disabled
              ? update.mutate(
                  { id: user.id, input: { disabled: false } },
                  { onError: (error) => notify.error('Not saved', messageOf(error)) },
                )
              : setDisabling(true),
        }
      : undefined

  return (
    <SideSheet
      open
      onClose={onClose}
      id={shortId(user.id)}
      copyId={user.id}
      title={user.name}
      {...position}
      quietActions={quietActionsOf([linkAction, toggle].filter((a) => a !== undefined))}
      more={
        canWrite
          ? [{ label: 'Edit name and email', icon: Pencil, onAction: () => setEditing(true) }]
          : []
      }
      tabs={{
        'aria-label': 'Person details',
        selected: tab,
        onSelect: (id) => {
          const next = sheetTabs.find((t) => t === id)
          if (next) onTab(next)
        },
        items: [
          { id: 'role', label: 'Role and access' },
          { id: 'sign-in', label: 'Sign-in', badge: signInCount },
          { id: 'teams', label: 'Teams', badge: user.teams?.length ?? 0 },
          { id: 'activity', label: 'Activity' },
        ],
      }}
    >
      <div className="mb-4 flex flex-col gap-2.5">
        <div className="flex items-center gap-2.5">
          <Avatar src={user.avatarUrl} name={user.name} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-semibold">
              {user.name}
              {self ? <span className="ml-1.5 text-xs font-normal text-muted">you</span> : null}
            </span>
            <span className="mono truncate text-xs text-muted">{user.email ?? 'no email'}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag tone={userStatusTone[status]} dot>
            {userStatusLabels[status]}
          </Tag>
          <Tag>{roleNames[roleOf(user.grants).role]}</Tag>
          {(user.teams ?? []).map((team) => (
            <Tag key={team}>
              Team <GroupName group={team} />
            </Tag>
          ))}
          <span className="text-xs text-muted">
            Added {formatDate(user.createdAt)}
            {user.creator ? ` by ${user.creator.name}` : ''}
          </span>
        </div>
        {note ? <p className="text-xs text-muted">{note}</p> : null}
        <p className="text-xs text-muted">{signInLabel(user)}</p>
      </div>
      {tab === 'role' ? (
        <RoleTab key={user.id} user={user} canEdit={canWrite && !self} />
      ) : tab === 'sign-in' ? (
        <SignInTab user={user} canEdit={canWrite} />
      ) : tab === 'teams' ? (
        <TeamsTab user={user} />
      ) : (
        <ActivityTab user={user} />
      )}
      {editing ? <EditProfileDialog user={user} onClose={() => setEditing(false)} /> : null}
      <ConfirmDialog
        isOpen={disabling}
        onOpenChange={setDisabling}
        title={`Disable ${user.name}?`}
        confirmLabel="Disable"
        isPending={update.isPending}
        onConfirm={() =>
          update.mutate(
            { id: user.id, input: { disabled: true } },
            {
              onSuccess: () => setDisabling(false),
              onError: (error) => notify.error('Not saved', messageOf(error)),
            },
          )
        }
      >
        {user.name} is signed out everywhere and cannot sign in until someone enables them again.
      </ConfirmDialog>
    </SideSheet>
  )
}
