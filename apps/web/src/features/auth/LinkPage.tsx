import { useNavigate, useParams } from '@tanstack/react-router'
import { Fingerprint, KeyRound } from 'lucide-react'
import { useState } from 'react'

import { ApiError, messageOf } from '../../api/client.ts'
import { useLinkInfo, useRegisterPasskey } from '../../api/queries.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { Button, Loading, Notice, TextField } from '../../ui/index.ts'
import { AuthCard } from './AuthCard.tsx'

/** `/link/:token` — sets up a first passkey, or a new one for recovery. */
export function LinkPage() {
  const { token } = useParams({ from: '/link/$token' })
  const navigate = useNavigate()
  const info = useLinkInfo(token)
  const register = useRegisterPasskey(token)
  const [label, setLabel] = useState('')

  if (info.isPending)
    return (
      <AuthCard title="Checking link">
        <Loading />
      </AuthCard>
    )
  if (info.isError) {
    const gone =
      info.error instanceof ApiError && (info.error.status === 404 || info.error.status === 400)
    return (
      <AuthCard title="Link unavailable">
        <Notice
          tone="danger"
          title={gone ? 'This link is invalid, used or expired' : 'Could not check the link'}
        >
          {gone ? 'Ask an administrator for a new one.' : messageOf(info.error)}
        </Notice>
      </AuthCard>
    )
  }

  const { purpose, userName, expiresAt } = info.data
  return (
    <AuthCard
      title={purpose === 'enroll' ? `Welcome, ${userName}` : `Recover access for ${userName}`}
      subtitle={
        purpose === 'enroll'
          ? 'Create a passkey to finish setting up your account.'
          : 'Create a new passkey; your existing ones keep working.'
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          register.mutate(label, { onSuccess: () => void navigate({ to: '/' }) })
        }}
      >
        {register.error ? (
          <Notice tone="danger" title="Passkey not created">
            {messageOf(register.error)}
          </Notice>
        ) : null}
        <TextField
          label="Passkey name"
          value={label}
          onChange={setLabel}
          placeholder="e.g. MacBook Touch ID"
          description="Helps you tell passkeys apart later. Optional."
        />
        <Button type="submit" variant="primary" size="lg" fullWidth isPending={register.isPending}>
          <Fingerprint className="size-4" />
          Create passkey
        </Button>
        <p
          className="flex items-center justify-center gap-1.5 text-xs text-muted"
          title={formatDateTime(expiresAt)}
        >
          <KeyRound className="size-3.5" />
          Link expires {formatRelative(expiresAt)}
        </p>
      </form>
    </AuthCard>
  )
}
