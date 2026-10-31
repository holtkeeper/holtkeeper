import type { LinkResponse, UserView } from '@holtkeeper/api'
import { Fingerprint, LifeBuoy, Pencil, Trash2, UserPlus, Users } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useUserMutations, useUsers } from '../../api/queries.ts'
import { summarizeGrants } from '../../lib/access.ts'
import { formatDate, formatRelative } from '../../lib/format.ts'
import {
  Avatar,
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Page,
  Panel,
  Placeholder,
  Switch,
  Tooltip,
  notify,
} from '../../ui/index.ts'
import { ScopeBadge } from '../access/ScopeEditor.tsx'
import { Forbidden } from '../shell/Forbidden.tsx'
import { useSession } from '../shell/session.ts'
import { LinkDialog, UserDialog } from './UserDialog.tsx'

/** People who can sign in with the `users` provider. */
export function UsersPage() {
  const { auth, can, principal } = useSession()
  const enabled = auth.provider === 'users'
  const users = useUsers(enabled)
  const { update, recovery, removePasskey } = useUserMutations()
  const [editing, setEditing] = useState<UserView | 'new' | null>(null)
  const [link, setLink] = useState<LinkResponse | null>(null)
  const [passkey, setPasskey] = useState<{ user: UserView; id: string; label: string } | null>(null)

  if (!enabled)
    return (
      <Page title="Users" icon="users">
        <Forbidden />
      </Page>
    )

  const canWrite = can('users:write')
  const canInvite = can('users:invite')
  const list = users.data?.users ?? []
  const byName = new Map(list.map((u) => [u.id, u.name]))

  return (
    <Page
      title="Users"
      icon="users"
      description="Accounts signing in with passkeys or single sign-on"
      actions={
        canInvite ? (
          <Button variant="primary" onPress={() => setEditing('new')}>
            <UserPlus className="size-4" />
            Invite user
          </Button>
        ) : null
      }
    >
      {users.isPending ? (
        <Placeholder className="h-64" />
      ) : users.isError ? (
        <ErrorState error={users.error} />
      ) : list.length === 0 ? (
        <EmptyState icon={<Users />} title="No users" />
      ) : (
        <div className="flex flex-col gap-3">
          <AnimatePresence initial={false}>
            {list.map((user) => (
              <motion.div
                key={user.id}
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: user.disabled ? 0.65 : 1 }}
              >
                <Panel>
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto]">
                    <div className="flex min-w-0 gap-3">
                      <Avatar src={user.avatarUrl} name={user.name} size="sm" className="mt-0.5" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{user.name}</span>
                          {user.id === principal.id ? <Chip tone="accent">you</Chip> : null}
                          {user.disabled ? <Chip tone="danger">disabled</Chip> : null}
                        </div>
                        <div className="truncate text-xs text-muted">
                          {user.email ?? 'no email'}
                        </div>
                        <div className="mt-1 text-xs text-muted">
                          Added {formatDate(user.createdAt)}
                          {user.createdBy
                            ? ` by ${byName.get(user.createdBy) ?? user.createdBy}`
                            : ''}
                        </div>
                      </div>
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <span className="text-xs font-medium text-muted">
                        {summarizeGrants(user.grants)}
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {user.grants.map((grant, i) => (
                          <Tooltip key={i} content={grant.actions.join(', ')}>
                            <span tabIndex={0} className="inline-flex max-w-full">
                              <ScopeBadge scope={grant.scope} />
                            </span>
                          </Tooltip>
                        ))}
                      </div>
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5 text-xs">
                      {user.passkeys.length === 0 ? (
                        <span className="text-warning">No passkey yet</span>
                      ) : (
                        user.passkeys.map((key) => (
                          <span key={key.id} className="flex items-center gap-1.5">
                            <Fingerprint className="size-3.5 text-muted" />
                            <span className="truncate">{key.label ?? 'Passkey'}</span>
                            <span className="text-muted">
                              {key.lastUsedAt
                                ? `used ${formatRelative(key.lastUsedAt)}`
                                : 'never used'}
                            </span>
                            {canWrite ? (
                              <button
                                type="button"
                                aria-label={`Remove passkey ${key.label ?? key.id}`}
                                className="rounded p-0.5 text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-focus"
                                onClick={() =>
                                  setPasskey({ user, id: key.id, label: key.label ?? 'Passkey' })
                                }
                              >
                                <Trash2 className="size-3" />
                              </button>
                            ) : null}
                          </span>
                        ))
                      )}
                      {user.identities.map((identity) => (
                        <span
                          key={`${identity.provider}-${identity.email ?? ''}`}
                          className="text-muted"
                        >
                          {identity.provider}
                          {identity.email ? ` · ${identity.email}` : ''}
                        </span>
                      ))}
                    </div>
                    {canWrite ? (
                      <div className="flex flex-wrap items-start gap-2 lg:flex-col lg:items-end">
                        <Switch
                          label="Enabled"
                          isSelected={!user.disabled}
                          isDisabled={user.id === principal.id || update.isPending}
                          onChange={(on) =>
                            update.mutate(
                              { id: user.id, input: { disabled: !on } },
                              { onError: (error) => notify.error('Not saved', messageOf(error)) },
                            )
                          }
                        />
                        <div className="flex gap-1">
                          <Tooltip content="Create a recovery link">
                            <Button
                              variant="ghost"
                              size="sm"
                              isIconOnly
                              aria-label={`Recovery link for ${user.name}`}
                              isPending={recovery.isPending && recovery.variables === user.id}
                              onPress={() =>
                                recovery.mutate(user.id, {
                                  onSuccess: setLink,
                                  onError: (error) =>
                                    notify.error('No link created', messageOf(error)),
                                })
                              }
                            >
                              <LifeBuoy className="size-4" />
                            </Button>
                          </Tooltip>
                          <Button
                            variant="ghost"
                            size="sm"
                            isIconOnly
                            aria-label={`Edit ${user.name}`}
                            onPress={() => setEditing(user)}
                          >
                            <Pencil className="size-4" />
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </Panel>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {editing ? (
        <UserDialog
          {...(editing === 'new' ? {} : { user: editing })}
          onClose={() => setEditing(null)}
          onLink={setLink}
        />
      ) : null}
      {link ? <LinkDialog link={link} onClose={() => setLink(null)} /> : null}
      <ConfirmDialog
        isOpen={passkey !== null}
        onOpenChange={(open) => !open && setPasskey(null)}
        title={`Remove passkey “${passkey?.label ?? ''}”?`}
        confirmLabel="Remove"
        isPending={removePasskey.isPending}
        onConfirm={() =>
          passkey &&
          removePasskey.mutate(
            { userId: passkey.user.id, passkeyId: passkey.id },
            {
              onSuccess: () => {
                notify.success('Passkey removed')
                setPasskey(null)
              },
              onError: (error) => notify.error('Not removed', messageOf(error)),
            },
          )
        }
      >
        {passkey?.user.name} can no longer sign in with it.
      </ConfirmDialog>
    </Page>
  )
}
