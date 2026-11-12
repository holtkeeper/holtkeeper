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
import { useAiBudget, useWeekUsageByProvider } from '../../api/settings-ai.ts'
import { formatUsd } from '../../lib/ai-usage.ts'
import { credentialStatus, lastUsedLabel } from '../../lib/credential-status.ts'
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
  Placeholder,
  Tag,
  Tooltip,
  notify,
} from '../../ui/index.ts'
import { ScopeBadge } from '../access/ScopeEditor.tsx'
import { useSectionHeader } from '../settings/section-header.ts'
import { SettingsSection } from '../settings/SettingsSection.tsx'
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

/** This week's spend and runs per provider credential name, when the viewer may read usage. */
function useProviderSpend(enabled: boolean): Map<string, { costUsd: number; runs: number }> {
  const budget = useAiBudget(enabled)
  const usage = useWeekUsageByProvider(budget.data?.week.from, enabled)
  return new Map(
    (usage.data?.buckets ?? []).map((bucket) => [
      bucket.key.provider ?? '',
      { costUsd: bucket.costUsd, runs: bucket.runs - bucket.denied },
    ]),
  )
}

/**
 * Settings › AI › Providers: AI provider credentials as cards with expiry, rotation, scope, whether
 * agents use them, this week's spend, the last use, their models and a test.
 */
export function Credentials() {
  const { can } = useSession()
  const credentials = useCredentials()
  const { rotate, remove } = useCredentialMutations()
  const test = useTestCredential()
  const [editing, setEditing] = useState<CredentialView | 'new' | null>(null)
  const [deleting, setDeleting] = useState<CredentialView | null>(null)
  const [browsing, setBrowsing] = useState<CredentialView | null>(null)
  const writable = can('credentials:write')
  const spend = useProviderSpend(can('ai:read') || can('ai:admin'))
  const now = new Date()
  const list = (credentials.data?.credentials ?? []).filter((credential) =>
    aiProviderKinds.includes(credential.kind),
  )
  useSectionHeader(
    writable
      ? { primary: { label: 'Add provider', icon: Plus, onPress: () => setEditing('new') } }
      : undefined,
  )

  return (
    <SettingsSection
      title={<span id="providers">Providers</span>}
      description="Keys and endpoints agents run on. One provider serves all repositories. Secrets are sealed by the vault and never shown again."
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
          title="No AI provider yet"
          description="Add an Anthropic key or a gateway so agents can run."
          action={
            writable ? (
              <Button variant="secondary" onPress={() => setEditing('new')}>
                Add provider
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
                className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4"
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
                  <div className="flex shrink-0 items-center gap-1.5">
                    {credential.usedBy?.some((use) => use.id === 'llm.provider') ? (
                      <Tag tone="accent">Agents use it</Tag>
                    ) : null}
                    <Chip variant="secondary">{credential.kind}</Chip>
                  </div>
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
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted">This week</dt>
                  <dd className="font-mono">
                    {spend.has(credential.name)
                      ? `${formatUsd(spend.get(credential.name)!.costUsd)} · ${plural(spend.get(credential.name)!.runs, 'run')}`
                      : '—'}
                  </dd>
                  <dt className="text-muted">Last used</dt>
                  <dd
                    title={
                      credential.lastUsedAt ? formatDateTime(credential.lastUsedAt) : undefined
                    }
                  >
                    {lastUsedLabel(credential.lastUsedAt, now)}
                  </dd>
                  <dt className="text-muted">Status</dt>
                  <dd>
                    {(() => {
                      const status = credentialStatus(credential, now)
                      return (
                        <span className="inline-flex items-center gap-1.5" title={status.why}>
                          <Tag tone={status.tone} dot>
                            {status.label}
                          </Tag>
                          {credential.capabilities?.agentLoop === 'ok' ? (
                            <span className="text-muted">tool use works</span>
                          ) : null}
                        </span>
                      )
                    })()}
                  </dd>
                </dl>
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
                      {writable ? (
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
                                        result.capabilities
                                          ? `${result.model}: tool use works, agent tasks run on the Claude Agent SDK`
                                          : `${result.model}: ${result.reply ?? ''}`,
                                      )
                                    : notify.error(
                                        `${credential.name} failed`,
                                        result.capabilities
                                          ? `${result.error ?? ''} — agent tasks fall back to the AI SDK loop`
                                          : result.error,
                                      ),
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
    </SettingsSection>
  )
}
