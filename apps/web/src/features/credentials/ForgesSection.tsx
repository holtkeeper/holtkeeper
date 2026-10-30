import type {
  ConfigEntryView,
  CredentialView,
  ForgeSshKeyInput,
  ForgeSshKeyView,
} from '@holtkeeper/api'
import { Fingerprint, GitBranch, KeyRound, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useCredentials, useForgeMutations, useForges } from '../../api/queries.ts'
import { formatDate } from '../../lib/format.ts'
import {
  Button,
  Chip,
  ConfirmDialog,
  CopyField,
  Dialog,
  EmptyState,
  ErrorState,
  Notice,
  Panel,
  Placeholder,
  Select,
  TextField,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { type ForgeDraft, toForgeDraft, toForgeInput, validateForgeDraft } from './forge-form.ts'

type ForgeEntry = ConfigEntryView<'forge'>

const usages = ['auth_and_signing', 'auth', 'signing'] as const

const isUsage = (value: string): value is ForgeSshKeyView['usage'] =>
  usages.some((usage) => usage === value)

const usageLabels: Record<ForgeSshKeyView['usage'], string> = {
  auth_and_signing: 'Clone, push and sign',
  auth: 'Clone and push',
  signing: 'Sign commits',
}

/** Panel forges and those from the config file, each with the SSH key it issued. */
export function ForgesSection() {
  const { can } = useSession()
  const readable = can('settings:read')
  const writable = can('settings:write')
  const forges = useForges(readable)
  const credentials = useCredentials(can('credentials:read'))
  const { remove, removeSshKey } = useForgeMutations()
  const [editing, setEditing] = useState<ForgeEntry | 'new' | null>(null)
  const [issuing, setIssuing] = useState<ForgeEntry | null>(null)
  const [deleting, setDeleting] = useState<ForgeEntry | null>(null)
  const [unkeying, setUnkeying] = useState<ForgeEntry | null>(null)
  if (!readable) return null
  const list = forges.data?.entries ?? []
  const tokens = (credentials.data?.credentials ?? []).filter((c) => c.kind === 'gitlab')
  const nameOf = (id: string | undefined) =>
    credentials.data?.credentials.find((c) => c.id === id)?.name ?? id

  return (
    <Panel
      title="Forges"
      description="Where repositories live. A forge uses a GitLab token credential and can issue an SSH key on that account for cloning, pushing and signing commits."
      actions={
        writable ? (
          <Button variant="secondary" size="sm" onPress={() => setEditing('new')}>
            <Plus className="size-4" />
            Add forge
          </Button>
        ) : null
      }
    >
      {forges.isPending ? (
        <Placeholder className="h-24" />
      ) : forges.isError ? (
        <ErrorState error={forges.error} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<GitBranch />}
          title="No forge yet"
          description="Add a GitLab forge to start adding repositories."
        />
      ) : (
        <ul className="flex flex-col divide-y divide-separator">
          {list.map((forge) => {
            const panel = forge.provenance !== 'file'
            const sshKey = forge.data.sshKey
            return (
              <li key={forge.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-default">
                      <GitBranch className="size-4.5" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 font-medium">
                        {forge.id}
                        <Chip variant="secondary">{forge.data.kind}</Chip>
                        {panel ? null : <Chip>config file</Chip>}
                      </div>
                      <div className="truncate font-mono text-xs text-muted">
                        {forge.data.url}
                        {forge.data.credentialId
                          ? ` · token ${nameOf(forge.data.credentialId) ?? ''}`
                          : ''}
                      </div>
                    </div>
                  </div>
                  {writable && panel ? (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        isIconOnly
                        aria-label={`Edit ${forge.id}`}
                        onPress={() => setEditing(forge)}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        isIconOnly
                        aria-label={`Delete ${forge.id}`}
                        onPress={() => setDeleting(forge)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  ) : null}
                </div>
                {sshKey ? (
                  <SshKeySummary
                    sshKey={sshKey}
                    actions={
                      writable ? (
                        <>
                          <Button variant="ghost" size="sm" onPress={() => setIssuing(forge)}>
                            <RefreshCw className="size-3.5" />
                            Rotate
                          </Button>
                          <Button variant="ghost" size="sm" onPress={() => setUnkeying(forge)}>
                            <Trash2 className="size-3.5" />
                            Remove
                          </Button>
                        </>
                      ) : null
                    }
                  />
                ) : panel && writable && forge.data.kind === 'gitlab' ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-separator p-3 text-sm text-muted">
                    No SSH key. Jobs clone over HTTPS with the token and commit through the API.
                    <Button variant="secondary" size="sm" onPress={() => setIssuing(forge)}>
                      <KeyRound className="size-3.5" />
                      Issue SSH key
                    </Button>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      {editing ? (
        <ForgeDialog
          key={editing === 'new' ? 'new' : editing.id}
          {...(editing === 'new' ? {} : { forge: editing })}
          taken={list.map((forge) => forge.id)}
          tokens={tokens}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {issuing ? (
        <SshKeyDialog key={issuing.id} forge={issuing} onClose={() => setIssuing(null)} />
      ) : null}
      <ConfirmDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete forge ${deleting?.id ?? ''}?`}
        isPending={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              notify.success('Forge deleted', deleting.id)
              setDeleting(null)
            },
            onError: (error) => notify.error('Delete failed', messageOf(error)),
          })
        }
      >
        Its webhook and SSH key are removed from the forge as well. Groups that use it must be moved
        or deleted first.
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={unkeying !== null}
        onOpenChange={(open) => !open && setUnkeying(null)}
        title={`Remove the SSH key of ${unkeying?.id ?? ''}?`}
        isPending={removeSshKey.isPending}
        onConfirm={() =>
          unkeying &&
          removeSshKey.mutate(unkeying.id, {
            onSuccess: () => {
              notify.success('SSH key removed', unkeying.id)
              setUnkeying(null)
            },
            onError: (error) => notify.error('Not removed', messageOf(error)),
          })
        }
      >
        The key is deleted from the forge account and from Holtkeeper. Jobs go back to HTTPS and API
        commits.
      </ConfirmDialog>
    </Panel>
  )
}

function SshKeySummary({ sshKey, actions }: { sshKey: ForgeSshKeyView; actions: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-default/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Fingerprint className="size-4 text-muted" />
          <span className="font-mono text-xs">{sshKey.fingerprint}</span>
          <Chip tone="accent">{usageLabels[sshKey.usage]}</Chip>
          {sshKey.expiresAt ? <Chip>Expires {formatDate(sshKey.expiresAt)}</Chip> : null}
        </div>
        {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
      </div>
      <div className="flex flex-col gap-1 text-xs text-muted">
        {sshKey.usage !== 'auth' ? (
          sshKey.identity ? (
            <span>
              Signs as {sshKey.identity.name} &lt;{sshKey.identity.email}&gt;
            </span>
          ) : (
            <span className="text-warning">No commit email: commits are not signed.</span>
          )
        ) : null}
        {sshKey.usage !== 'signing' && !sshKey.hostKeysPinned ? (
          <span className="text-warning">
            Host keys are not pinned: git keeps using HTTPS. Rotate to scan them again.
          </span>
        ) : null}
      </div>
      <CopyField value={sshKey.publicKey} label="public key" />
    </div>
  )
}

function ForgeDialog({
  forge,
  taken,
  tokens,
  onClose,
}: {
  forge?: ForgeEntry
  taken: string[]
  tokens: CredentialView[]
  onClose: () => void
}) {
  const isNew = forge === undefined
  const [draft, setDraft] = useState<ForgeDraft>(() => toForgeDraft(forge))
  const [submitted, setSubmitted] = useState(false)
  const { put } = useForgeMutations()
  const errors = submitted ? validateForgeDraft(draft, isNew ? taken : []) : {}
  const set = <K extends keyof ForgeDraft>(key: K, value: ForgeDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const submit = () => {
    setSubmitted(true)
    if (Object.keys(validateForgeDraft(draft, isNew ? taken : [])).length) return
    put.mutate(
      { id: draft.id.trim(), data: toForgeInput(draft) },
      {
        onSuccess: () => {
          notify.success(isNew ? 'Forge added' : 'Forge saved', draft.id)
          onClose()
        },
      },
    )
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={isNew ? 'Add forge' : `Edit ${forge.id}`}
      description="Repositories are addressed as <forge>:<path>, so the id cannot change later."
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onPress={submit} isPending={put.isPending}>
            {isNew ? 'Add' : 'Save'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {put.error ? (
          <Notice tone="danger" title="Not saved">
            {messageOf(put.error)}
          </Notice>
        ) : null}
        {forge?.provenance === 'file+panel' ? (
          <Notice title="Overrides the config file">
            Deleting this forge brings back the entry from the config file.
          </Notice>
        ) : null}
        <TextField
          label="Id"
          value={draft.id}
          onChange={(v) => set('id', v)}
          error={errors.id}
          placeholder="work"
          mono
          isRequired
          isDisabled={!isNew}
          autoFocus={isNew}
        />
        <TextField
          label="URL"
          type="url"
          value={draft.url}
          onChange={(v) => set('url', v)}
          error={errors.url}
          placeholder="https://gitlab.com"
          mono
          isRequired
        />
        {tokens.length ? (
          <div className="flex flex-col gap-1">
            <Select
              label="Token"
              options={tokens.map((c) => ({
                id: c.id,
                text: c.name,
                label: (
                  <span className="flex items-baseline gap-2">
                    {c.name}
                    <span className="truncate font-mono text-[11px] text-muted">{c.url}</span>
                  </span>
                ),
              }))}
              value={draft.credentialId || undefined}
              onChange={(id) => {
                const token = tokens.find((c) => c.id === id)
                setDraft((d) => ({ ...d, credentialId: id, url: d.url || (token?.url ?? '') }))
              }}
              placeholder="Choose a GitLab credential"
            />
            {errors.credentialId ? (
              <span className="text-xs text-danger">{errors.credentialId}</span>
            ) : (
              <span className="text-xs text-muted">
                Needs the api scope; with an SSH key it also registers keys on this account.
              </span>
            )}
          </div>
        ) : (
          <Notice tone="warning" title="No GitLab credential">
            Create a GitLab credential with the token first.
          </Notice>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

function SshKeyDialog({ forge, onClose }: { forge: ForgeEntry; onClose: () => void }) {
  const current = forge.data.sshKey
  const [usage, setUsage] = useState<ForgeSshKeyView['usage']>(current?.usage ?? 'auth_and_signing')
  const [days, setDays] = useState('365')
  const [name, setName] = useState(current?.identity?.name ?? '')
  const [email, setEmail] = useState(current?.identity?.email ?? '')
  const { issueSshKey } = useForgeMutations()
  const lifetime = Number(days)
  const daysError =
    Number.isInteger(lifetime) && lifetime >= 1 ? undefined : 'Whole days, 1 or more'
  const identityError =
    (name.trim() === '') !== (email.trim() === '')
      ? 'Set both name and email, or neither'
      : undefined

  const submit = () => {
    if (daysError || identityError) return
    const input: ForgeSshKeyInput = {
      usage,
      expiresInDays: lifetime,
      ...(name.trim() && email.trim() && { identity: { name: name.trim(), email: email.trim() } }),
    }
    issueSshKey.mutate(
      { id: forge.id, input },
      {
        onSuccess: (result) => {
          notify.success(current ? 'SSH key rotated' : 'SSH key issued', forge.id)
          for (const note of result.notes) notify.info(forge.id, note)
          onClose()
        },
      },
    )
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={current ? `Rotate the SSH key of ${forge.id}` : `Issue an SSH key for ${forge.id}`}
      description="Holtkeeper generates an Ed25519 key, registers it on the account behind the forge token and keeps the private half sealed. Host keys are trusted on first use."
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onPress={submit} isPending={issueSshKey.isPending}>
            {current ? 'Rotate' : 'Issue'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {issueSshKey.error ? (
          <Notice tone="danger" title="No key">
            {messageOf(issueSshKey.error)}
          </Notice>
        ) : null}
        <Select
          label="Used for"
          options={usages.map((id) => ({ id, label: usageLabels[id] }))}
          value={usage}
          onChange={(value) => isUsage(value) && setUsage(value)}
        />
        <TextField
          label="Lifetime (days)"
          type="number"
          min={1}
          value={days}
          onChange={setDays}
          error={daysError}
          description="The forge stops accepting the key afterwards; rotate before then."
        />
        {usage === 'auth' ? null : (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Commit name"
              value={name}
              onChange={setName}
              placeholder="From the forge account"
            />
            <TextField
              label="Commit email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="From the forge account"
              error={identityError}
              description="Must be a verified email of the account for commits to show as verified."
            />
          </div>
        )}
      </div>
    </Dialog>
  )
}
