import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { Check, Fingerprint, KeyRound, Link2Off } from 'lucide-react'
import { useState } from 'react'

import { ApiError, linkGoneOf, messageOf } from '../../api/client.ts'
import { useLinkInfo, useRegisterPasskey } from '../../api/queries.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { isCancelled, linkGrantsText } from '../../lib/passkeys.ts'
import { Button, KeyValue, Loading, Notice, TextField, buttonClass } from '../../ui/index.ts'
import { AuthCard } from './AuthCard.tsx'

const steps = ['Link checked', 'Create passkey', 'Open Home'] as const

function Steps({ current }: { current: number }) {
  return (
    <ol
      aria-label={`Setup progress, step ${current + 1} of ${steps.length}`}
      className="mb-5 flex items-center gap-2 text-xs"
    >
      {steps.map((label, index) => {
        const done = index < current
        const now = index === current
        return (
          <li
            key={label}
            className={`flex items-center gap-1.5 ${now ? 'text-foreground' : 'text-muted'}`}
            {...(now ? { 'aria-current': 'step' as const } : {})}
          >
            <span
              className={`grid size-5 place-items-center rounded-full text-[10px] font-semibold ${
                done
                  ? 'bg-success-soft text-success'
                  : now
                    ? 'bg-accent text-accent-foreground'
                    : 'bg-raise text-muted'
              }`}
            >
              {done ? <Check className="size-3" /> : index + 1}
            </span>
            {label}
            {index < steps.length - 1 ? (
              <span aria-hidden className="h-px w-4 bg-separator" />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

function Unavailable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const gone = linkGoneOf(error)
  const invalid = error instanceof ApiError && (error.status === 404 || error.status === 400)
  const known = gone !== undefined || invalid
  return (
    <AuthCard title="Link unavailable">
      <div className="flex flex-col gap-4">
        <div className="flex gap-3 text-sm">
          <Link2Off className="mt-0.5 size-4 shrink-0 text-danger" />
          <p className="text-muted">
            {gone ? (
              <>
                This link {gone.state === 'used' ? 'was already used on' : 'expired on'}{' '}
                <span className="text-foreground">{formatDateTime(gone.at)}</span>. Each link works
                once. Ask an admin for a new one.
              </>
            ) : invalid ? (
              'This link is not valid. Check that you copied all of it, or ask an admin for a new one.'
            ) : (
              <>Could not check the link: {messageOf(error)}</>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {known ? null : (
            <Button variant="secondary" size="sm" onPress={onRetry}>
              Retry
            </Button>
          )}
          <Link to="/" className={buttonClass('ghost', 'sm')}>
            Back to sign in
          </Link>
        </div>
      </div>
    </AuthCard>
  )
}

/**
 * `/link/:token` — sets up a first passkey, or a new one for recovery, in three steps: who invited
 * the person and what they get (role and number of grants only), a passkey name, and the expiry.
 * A used or expired link says when; a cancelled browser prompt leaves the link valid.
 */
export function LinkPage() {
  const { token } = useParams({ from: '/link/$token' })
  const navigate = useNavigate()
  const info = useLinkInfo(token)
  const register = useRegisterPasskey(token)
  const [label, setLabel] = useState('')

  if (info.isPending)
    return (
      <AuthCard title="Checking link">
        <Loading label="Checking link" />
      </AuthCard>
    )
  if (info.isError) return <Unavailable error={info.error} onRetry={() => void info.refetch()} />

  const { purpose, userName, expiresAt, grants } = info.data
  const enroll = purpose === 'enroll'
  return (
    <AuthCard
      title={enroll ? `Welcome, ${userName}` : `Recover access for ${userName}`}
      subtitle={
        enroll
          ? 'Create a passkey to finish setting up your account.'
          : 'Create a new passkey; your existing ones keep working.'
      }
    >
      <Steps current={register.isSuccess ? 2 : 1} />
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          register.mutate(label, { onSuccess: () => void navigate({ to: '/' }) })
        }}
      >
        <KeyValue
          labelWidth={88}
          rows={[
            { label: enroll ? 'You get' : 'Your access', value: linkGrantsText(grants) },
            { label: 'Instance', value: <span className="mono">{window.location.host}</span> },
          ]}
        />
        {register.error ? (
          <Notice tone="danger" title="Passkey not created">
            {isCancelled(register.error)
              ? 'The browser prompt was cancelled; the link stays valid.'
              : messageOf(register.error)}
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
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <KeyRound className="size-3.5" />
          Link expires {formatRelative(expiresAt)},{' '}
          <span className="mono">{formatDateTime(expiresAt)}</span>
          <span className="flex-1" />
          <span className="text-dim">Single use</span>
        </p>
      </form>
    </AuthCard>
  )
}
