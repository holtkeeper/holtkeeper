import type { Grant, LinkResponse, UserView } from '@holtkeeper/api'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useRepos, useUserMutations } from '../../api/queries.ts'
import { isEmptyScope, normalizeScope } from '../../lib/scope.ts'
import { Button, Dialog, Notice, TextField, notify } from '../../ui/index.ts'
import { GrantsEditor } from '../access/GrantsEditor.tsx'
import { LinkBody } from './LinkBody.tsx'

const cleanGrants = (grants: readonly Grant[]): Grant[] =>
  grants.map((grant) => ({ scope: normalizeScope(grant.scope), actions: grant.actions }))

/** Invites a new user (then shows the setup link) or edits an existing user's name and grants. */
export function UserDialog({
  user,
  onClose,
  onLink,
}: {
  user?: UserView
  onClose: () => void
  onLink: (link: LinkResponse) => void
}) {
  const isNew = user === undefined
  const [name, setName] = useState(user?.name ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [grants, setGrants] = useState<Grant[]>(
    user?.grants ?? [{ scope: { all: true }, actions: ['repos:read', 'audits:read'] }],
  )
  const { invite, update } = useUserMutations()
  const repos = useRepos()
  const groups = [...new Set((repos.data?.repos ?? []).flatMap((r) => r.groups))].toSorted()
  const mutation = isNew ? invite : update
  const problem = !name.trim()
    ? 'Name is required'
    : grants.some((g) => g.actions.length === 0)
      ? 'Every grant needs at least one action'
      : grants.some((g) => isEmptyScope(g.scope))
        ? 'Every grant needs a scope'
        : undefined

  const save = () => {
    const input = {
      name: name.trim(),
      ...(email.trim() ? { email: email.trim() } : {}),
      grants: cleanGrants(grants),
    }
    if (isNew) {
      invite.mutate(input, {
        onSuccess: (link) => {
          onClose()
          onLink(link)
        },
      })
    } else {
      update.mutate(
        { id: user.id, input },
        {
          onSuccess: () => {
            notify.success('User saved', input.name)
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
      size="lg"
      title={isNew ? 'Invite user' : `Edit ${user.name}`}
      description={
        isNew
          ? 'The user gets a one-time link to create a passkey.'
          : 'Grants can only stay within your own.'
      }
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onPress={save}
            isDisabled={problem !== undefined}
            isPending={mutation.isPending}
          >
            {isNew ? 'Create invite link' : 'Save'}
          </Button>
        </>
      }
    >
      {mutation.error ? (
        <Notice tone="danger" title="Not saved">
          {messageOf(mutation.error)}
        </Notice>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Name" value={name} onChange={setName} isRequired autoFocus />
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          description="Optional; links OIDC sign-ins."
        />
      </div>
      <GrantsEditor value={grants} onChange={setGrants} groups={groups} />
      {problem && name ? <p className="text-xs text-danger">{problem}</p> : null}
    </Dialog>
  )
}

/** Shows a setup or recovery link once, ready to copy. */
export function LinkDialog({ link, onClose }: { link: LinkResponse; onClose: () => void }) {
  const url = new URL(link.link, window.location.origin).toString()
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={`Link for ${link.user.name}`}
      description="Shown only once. Send it over a trusted channel."
      footer={
        <Button variant="primary" onPress={onClose}>
          Done
        </Button>
      }
    >
      <LinkBody url={url} expiresAt={link.expiresAt} />
    </Dialog>
  )
}
