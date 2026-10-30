import type { CredentialView } from '@holtkeeper/api'
import {
  Boxes,
  CalendarClock,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Zap,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useCredentialMutations, useCredentials, useTestCredential } from '../../api/queries.ts'
import {
  daysUntil,
  expiryTone,
  formatDate,
  formatDateTime,
  formatRelative,
  plural,
} from '../../lib/format.ts'
import {
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Page,
  Placeholder,
  Tooltip,
  notify,
} from '../../ui/index.ts'
import { ScopeBadge } from '../access/ScopeEditor.tsx'
import { useSession } from '../shell/session.ts'
import { CredentialDialog } from './CredentialDialog.tsx'
import { aiProviderKinds } from './form.ts'
import { ModelsDialog } from './ModelsDialog.tsx'

function Expiry({ at }: { at: string | undefined }) {
  const tone = expiryTone(at)
  if (tone === 'none' || !at) return <span className="text-xs text-muted">No expiry</span>
  const days = daysUntil(at)
  return (
    <Tooltip content={formatDateTime(at)}>
      <span tabIndex={0} className="inline-flex">
        <Chip tone={tone === 'expired' ? 'danger' : tone === 'soon' ? 'warning' : 'default'}>
          <CalendarClock className="size-3" />
          {tone === 'expired'
            ? `Expired ${formatRelative(at)}`
            : days === 0
              ? 'Expires today'
              : `${plural(days, 'day')} left`}
        </Chip>
      </span>
    </Tooltip>
  )
}

/** Forge accounts and API keys with expiry, rotation and scope. */
export function CredentialsPage() {
  const { can } = useSession()
  const credentials = useCredentials()
  const { rotate, remove } = useCredentialMutations()
  const test = useTestCredential()
  const [editing, setEditing] = useState<CredentialView | 'new' | null>(null)
  const [deleting, setDeleting] = useState<CredentialView | null>(null)
  const [browsing, setBrowsing] = useState<CredentialView | null>(null)
  const writable = can('credentials:write')
  const list = credentials.data?.credentials ?? []

  return (
    <Page
      title="Credentials"
      description="Tokens Holtkeeper uses to reach forges and services"
      actions={
        writable ? (
          <Button variant="primary" onPress={() => setEditing('new')}>
            <Plus className="size-4" />
            New credential
          </Button>
        ) : null
      }
    >
      {credentials.isPending ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Placeholder className="h-40" />
          <Placeholder className="h-40" />
        </div>
      ) : credentials.isError ? (
        <ErrorState error={credentials.error} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<KeyRound />}
          title="No credentials yet"
          description="Add a forge token so Holtkeeper can open merge requests."
          action={
            writable ? (
              <Button variant="primary" onPress={() => setEditing('new')}>
                Add credential
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          <AnimatePresence initial={false}>
            {list.map((credential) => (
              <motion.li
                key={credential.id}
                layout
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 shadow-surface"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-default">
                      <KeyRound className="size-4.5" />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{credential.name}</div>
                      <div className="truncate font-mono text-xs text-muted">{credential.url}</div>
                    </div>
                  </div>
                  <Chip variant="secondary">{credential.kind}</Chip>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Expiry at={credential.expiresAt} />
                  <ScopeBadge scope={credential.scope} />
                  {credential.rotation?.enabled ? (
                    <Chip tone="accent">
                      <RefreshCw className="size-3" />
                      Rotates {credential.rotation.daysBefore} d before ·{' '}
                      {credential.rotation.lifetimeDays} d lifetime
                    </Chip>
                  ) : credential.rotatable ? (
                    <Chip>Manual rotation</Chip>
                  ) : null}
                </div>
                {credential.lastError ? (
                  <div className="flex items-start gap-2 rounded-xl bg-danger-soft p-2.5 text-xs text-danger-soft-foreground">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span className="break-words">
                      Last rotation failed: {credential.lastError}
                    </span>
                  </div>
                ) : null}
                <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-separator pt-3 text-xs text-muted">
                  <span>
                    {credential.lastRotatedAt
                      ? `Rotated ${formatRelative(credential.lastRotatedAt)}`
                      : `Added ${formatDate(credential.createdAt)}`}
                  </span>
                  {aiProviderKinds.includes(credential.kind) ? (
                    <span className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onPress={() => setBrowsing(credential)}>
                        <Boxes className="size-3.5" />
                        Models
                      </Button>
                      {credential.kind === 'ai-sdk' && writable ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          isPending={test.isPending && test.variables?.id === credential.id}
                          onPress={() =>
                            test.mutate(
                              { id: credential.id },
                              {
                                onSuccess: (result) =>
                                  result.ok
                                    ? notify.success(
                                        `${credential.name} answered in ${result.latencyMs ?? 0} ms`,
                                        `${result.model}: ${result.reply ?? ''}`,
                                      )
                                    : notify.error(`${credential.name} failed`, result.error),
                                onError: (error) =>
                                  notify.error(`${credential.name} failed`, messageOf(error)),
                              },
                            )
                          }
                        >
                          <Zap className="size-3.5" />
                          Test
                        </Button>
                      ) : null}
                    </span>
                  ) : null}
                  {writable ? (
                    <div className="flex items-center gap-1">
                      {credential.rotatable ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          isPending={rotate.isPending && rotate.variables === credential.id}
                          onPress={() =>
                            rotate.mutate(credential.id, {
                              onSuccess: () => notify.success('Rotated', credential.name),
                              onError: (error) => notify.error('Rotation failed', messageOf(error)),
                            })
                          }
                        >
                          <RefreshCw className="size-3.5" />
                          Rotate now
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        isIconOnly
                        aria-label={`Edit ${credential.name}`}
                        onPress={() => setEditing(credential)}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        isIconOnly
                        aria-label={`Delete ${credential.name}`}
                        onPress={() => setDeleting(credential)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  ) : null}
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      {browsing ? (
        <ModelsDialog key={browsing.id} credential={browsing} onClose={() => setBrowsing(null)} />
      ) : null}
      {editing ? (
        <CredentialDialog
          key={editing === 'new' ? 'new' : editing.id}
          isOpen
          onOpenChange={(open) => !open && setEditing(null)}
          {...(editing === 'new' ? {} : { credential: editing })}
        />
      ) : null}
      <ConfirmDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'credential'}?`}
        isPending={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              notify.success('Credential deleted', deleting.name)
              setDeleting(null)
            },
            onError: (error) => notify.error('Delete failed', messageOf(error)),
          })
        }
      >
        Anything using this credential stops working until another one covers it.
      </ConfirmDialog>
    </Page>
  )
}
