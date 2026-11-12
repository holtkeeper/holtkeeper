import { Fingerprint, Pencil, Plus, Trash2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type FormEvent, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useAccount, useAccountPasskeys } from '../../api/queries.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { isCancelled, passkeyName } from '../../lib/passkeys.ts'
import {
  Button,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Notice,
  Panel,
  Placeholder,
  TextField,
  Tooltip,
  notify,
} from '../../ui/index.ts'

type Editing = { mode: 'add' } | { mode: 'rename'; id: string; label: string }

function PasskeyDialog({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const { add, rename } = useAccountPasskeys()
  const [label, setLabel] = useState(editing.mode === 'rename' ? editing.label : '')
  const mutation = editing.mode === 'add' ? add : rename
  const error = mutation.error && !isCancelled(mutation.error) ? mutation.error : null

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (editing.mode === 'add') {
      add.mutate(label, {
        onSuccess: () => {
          notify.success('Passkey added')
          onClose()
        },
      })
    } else if (label.trim()) {
      rename.mutate(
        { id: editing.id, label },
        {
          onSuccess: () => {
            notify.success('Passkey renamed')
            onClose()
          },
        },
      )
    }
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={editing.mode === 'add' ? 'Add a passkey' : 'Rename passkey'}
      description={
        editing.mode === 'add'
          ? 'Your browser asks which device or password manager keeps the new passkey.'
          : undefined
      }
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onPress={() => submit()}
            isPending={mutation.isPending}
            isDisabled={editing.mode === 'rename' && !label.trim()}
          >
            {editing.mode === 'add' ? (
              <>
                <Fingerprint className="size-4" />
                Create passkey
              </>
            ) : (
              'Save'
            )}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error ? (
          <Notice tone="danger" title="Not saved">
            {messageOf(error)}
          </Notice>
        ) : null}
        <TextField
          label="Name"
          value={label}
          onChange={setLabel}
          autoFocus
          placeholder="e.g. iPhone, YubiKey, 1Password"
          {...(editing.mode === 'add'
            ? { description: 'Helps you tell passkeys apart later. Optional.' }
            : {})}
        />
      </form>
    </Dialog>
  )
}

/** Account › Sign-in (the `users` provider only): passkeys to add, rename and remove, and single sign-on identities. */
export function Passkeys() {
  const account = useAccount()
  const { remove } = useAccountPasskeys()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null)

  if (account.isPending) return <Placeholder className="h-48" />
  if (account.isError) return <ErrorState error={account.error} />

  const user = account.data
  const only = user.passkeys.length <= 1

  return (
    <>
      <Panel
        title="Passkeys"
        actions={
          <Button variant="secondary" size="sm" onPress={() => setEditing({ mode: 'add' })}>
            <Plus className="size-3.5" />
            Add passkey
          </Button>
        }
      >
        {only ? (
          <Notice tone="warning" title="Only one passkey">
            If you lose it, only an admin can let you back in with a recovery link.
          </Notice>
        ) : null}
        <ul className="flex flex-col divide-y divide-separator">
          <AnimatePresence initial={false}>
            {user.passkeys.map((passkey, index) => {
              const name = passkeyName(passkey, index)
              return (
                <motion.li
                  key={passkey.id}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3"
                >
                  <span className="grid size-9 place-items-center rounded-xl bg-accent-soft text-accent-soft-foreground">
                    <Fingerprint className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{name}</div>
                    <div className="text-xs text-muted">
                      <span title={formatDateTime(passkey.createdAt)}>
                        Added {formatRelative(passkey.createdAt)}
                      </span>
                      {' · '}
                      {passkey.lastUsedAt ? (
                        <span title={formatDateTime(passkey.lastUsedAt)}>
                          used {formatRelative(passkey.lastUsedAt)}
                        </span>
                      ) : (
                        'never used'
                      )}
                    </div>
                  </div>
                  <span className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      isIconOnly
                      aria-label={`Rename ${name}`}
                      onPress={() =>
                        setEditing({ mode: 'rename', id: passkey.id, label: passkey.label ?? '' })
                      }
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Tooltip content={only ? 'Add another passkey first' : 'Remove'}>
                      <span>
                        <Button
                          variant="ghost"
                          size="sm"
                          isIconOnly
                          aria-label={`Remove ${name}`}
                          isDisabled={only}
                          onPress={() => setRemoving({ id: passkey.id, name })}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </span>
                    </Tooltip>
                  </span>
                </motion.li>
              )
            })}
          </AnimatePresence>
        </ul>
      </Panel>

      {user.identities.length ? (
        <Panel title="Single sign-on">
          <ul className="flex flex-col gap-2 text-sm">
            {user.identities.map((identity) => (
              <li key={`${identity.provider}:${identity.email ?? ''}`} className="flex gap-2">
                <span className="mono">{identity.provider}</span>
                {identity.email ? <span className="text-muted">{identity.email}</span> : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      {editing ? (
        <PasskeyDialog
          key={editing.mode === 'rename' ? editing.id : 'add'}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        isOpen={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove “${removing?.name ?? ''}”?`}
        confirmLabel="Remove"
        isPending={remove.isPending}
        onConfirm={() =>
          removing &&
          remove.mutate(removing.id, {
            onSuccess: () => {
              notify.success('Passkey removed')
              setRemoving(null)
            },
            onError: (error) => notify.error('Not removed', messageOf(error)),
          })
        }
      >
        You can no longer sign in with it. Remove it from the device or password manager too.
      </ConfirmDialog>
    </>
  )
}
