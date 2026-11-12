import type { Grant, LinkResponse, Scope } from '@holtkeeper/api'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useGroupNames, useUserMutations } from '../../api/queries.ts'
import { type RolePresetId, grantsForRole } from '../../lib/roles.ts'
import { isEmptyScope, normalizeScope } from '../../lib/scope.ts'
import { Button, Dialog, Notice, Switch, TextField } from '../../ui/index.ts'
import { GrantsEditor } from '../access/GrantsEditor.tsx'
import { ScopeEditor } from '../access/ScopeEditor.tsx'
import { LinkBody } from './LinkBody.tsx'
import { RolePicker } from './RolePicker.tsx'

const cleanGrants = (grants: readonly Grant[]): Grant[] =>
  grants.map((grant) => ({ scope: normalizeScope(grant.scope), actions: grant.actions }))

/** Invites a person with a role on a scope, or exact grants, then shows their setup link. */
export function InviteDialog({
  onClose,
  onLink,
}: {
  onClose: () => void
  onLink: (link: LinkResponse) => void
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<RolePresetId>('viewer')
  const [scope, setScope] = useState<Scope>({ groups: [] })
  const [custom, setCustom] = useState(false)
  const [grants, setGrants] = useState<Grant[]>([
    { scope: { groups: [] }, actions: ['repos:read'] },
  ])
  const { invite } = useUserMutations()
  const groups = useGroupNames()
  const chosen = custom ? cleanGrants(grants) : grantsForRole(role, scope)
  const problem = !name.trim()
    ? 'Name is required'
    : chosen.some((g) => g.actions.length === 0)
      ? 'Every grant needs at least one action'
      : chosen.some((g) => isEmptyScope(g.scope))
        ? 'Pick the groups or repositories it applies to'
        : undefined

  const save = () =>
    invite.mutate(
      { name: name.trim(), ...(email.trim() ? { email: email.trim() } : {}), grants: chosen },
      {
        onSuccess: (link) => {
          onClose()
          onLink(link)
        },
      },
    )

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      title="Invite people"
      description="They get a one-time link to create a passkey. You can only give access you have yourself."
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onPress={save}
            isDisabled={problem !== undefined}
            isPending={invite.isPending}
          >
            Create invite link
          </Button>
        </>
      }
    >
      {invite.error ? (
        <Notice tone="danger" title="Not invited">
          {messageOf(invite.error)}
        </Notice>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Name" value={name} onChange={setName} isRequired autoFocus />
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          description="Optional; links single sign-on."
        />
      </div>
      <Switch label="Exact grants instead of a role" isSelected={custom} onChange={setCustom} />
      {custom ? (
        <GrantsEditor value={grants} onChange={setGrants} groups={groups} />
      ) : (
        <>
          <RolePicker label="Role" value={role} onChange={setRole} />
          {role === 'admin' ? (
            <p className="text-xs text-muted">Admin always applies to every repository.</p>
          ) : (
            <ScopeEditor value={scope} onChange={setScope} groups={groups} label="Applies to" />
          )}
        </>
      )}
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
