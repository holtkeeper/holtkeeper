import type { CredentialView } from '@holtkeeper/api'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useCredentialMutations, useRepos } from '../../api/queries.ts'
import { Button, Dialog, Notice, Select, Switch, TextField, notify } from '../../ui/index.ts'
import { ScopeEditor } from '../access/ScopeEditor.tsx'
import {
  type CredentialDraft,
  credentialKinds,
  defaultUrl,
  toCreateInput,
  toDraft,
  toUpdateInput,
  validateDraft,
} from './form.ts'

/** Create or edit a credential. The secret is write-only: editing never shows the stored one. */
export function CredentialDialog({
  credential,
  isOpen,
  onOpenChange,
}: {
  credential?: CredentialView
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}) {
  const isNew = credential === undefined
  const [draft, setDraft] = useState<CredentialDraft>(() => toDraft(credential))
  const [submitted, setSubmitted] = useState(false)
  const { create, update } = useCredentialMutations()
  const repos = useRepos()
  const groups = [...new Set((repos.data?.repos ?? []).flatMap((r) => r.groups))].toSorted()
  const errors = submitted ? validateDraft(draft, isNew) : {}
  const mutation = isNew ? create : update
  const set = <K extends keyof CredentialDraft>(key: K, value: CredentialDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const submit = () => {
    setSubmitted(true)
    if (Object.keys(validateDraft(draft, isNew)).length) return
    const done = {
      onSuccess: () => {
        notify.success(isNew ? 'Credential created' : 'Credential saved', draft.name)
        onOpenChange(false)
      },
    }
    if (isNew) create.mutate(toCreateInput(draft), done)
    else update.mutate({ id: credential.id, input: toUpdateInput(draft) }, done)
  }

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="lg"
      title={isNew ? 'New credential' : `Edit ${credential.name}`}
      description="Forge accounts and API keys. Secrets are sealed by the vault and never shown again."
      footer={
        <>
          <Button variant="tertiary" onPress={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onPress={submit} isPending={mutation.isPending}>
            {isNew ? 'Create' : 'Save'}
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
        {mutation.error ? (
          <Notice tone="danger" title="Not saved">
            {messageOf(mutation.error)}
          </Notice>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Name"
            value={draft.name}
            onChange={(v) => set('name', v)}
            error={errors.name}
            isRequired
            autoFocus
          />
          <Select
            label="Kind"
            options={credentialKinds.map((kind) => ({
              id: kind,
              label:
                kind === 'gitlab'
                  ? 'GitLab'
                  : kind === 'github'
                    ? 'GitHub'
                    : kind === 'anthropic'
                      ? 'Anthropic'
                      : 'Other',
            }))}
            value={credentialKinds.some((kind) => kind === draft.kind) ? draft.kind : 'other'}
            onChange={(kind) =>
              setDraft((d) => ({
                ...d,
                kind,
                url: !d.url || d.url === defaultUrl(d.kind) ? defaultUrl(kind) : d.url,
              }))
            }
          />
        </div>
        <TextField
          label="URL"
          type="url"
          value={draft.url}
          onChange={(v) => set('url', v)}
          error={errors.url}
          isRequired
          mono
        />
        <TextField
          label="Secret"
          type="password"
          value={draft.secret}
          onChange={(v) => set('secret', v)}
          error={errors.secret}
          isRequired={isNew}
          autoComplete="new-password"
          mono
          description={isNew ? 'Token or API key.' : 'Leave empty to keep the stored secret.'}
        />
        <TextField
          label="Expires"
          type="date"
          value={draft.expires}
          onChange={(v) => set('expires', v)}
          description="Optional. Used for countdowns and rotation."
        />
        <div className="flex flex-col gap-1">
          <ScopeEditor
            value={draft.scope}
            onChange={(scope) => set('scope', scope)}
            groups={groups}
            label="Usable by"
          />
          {errors.scope ? <span className="text-xs text-danger">{errors.scope}</span> : null}
        </div>
        <fieldset className="flex flex-col gap-3 rounded-xl border border-separator p-3">
          <legend className="px-1 text-sm font-medium">Rotation</legend>
          <Switch
            label="Rotate automatically"
            isSelected={draft.rotation}
            onChange={(on) => set('rotation', on)}
            description="Supported for forge tokens that can issue their own replacement."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Days before expiry"
              type="number"
              min={1}
              value={draft.daysBefore}
              onChange={(v) => set('daysBefore', v)}
              error={errors.daysBefore}
              isDisabled={!draft.rotation}
            />
            <TextField
              label="New token lifetime (days)"
              type="number"
              min={1}
              value={draft.lifetimeDays}
              onChange={(v) => set('lifetimeDays', v)}
              error={errors.lifetimeDays}
              isDisabled={!draft.rotation}
            />
          </div>
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
