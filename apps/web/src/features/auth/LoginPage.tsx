import type { AuthInfo } from '@holtkeeper/api'
import { Fingerprint, KeyRound, LifeBuoy, LogIn, UserPlus } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useAuthMutations } from '../../api/queries.ts'
import { isCancelled } from '../../lib/passkeys.ts'
import { Button, Notice, TextField, buttonClass } from '../../ui/index.ts'
import { AuthCard } from './AuthCard.tsx'

function Divider() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted">
      <span className="h-px flex-1 bg-separator" />
      or
      <span className="h-px flex-1 bg-separator" />
    </div>
  )
}

/**
 * Sign-in page offering exactly the methods the provider lists: a passkey first, then single
 * sign-on, then the admin password (folded away when anything else is offered). A closed passkey
 * prompt reads as cancelled, with Try again and the single sign-on alternative.
 */
export function LoginPage({ auth }: { auth: AuthInfo }) {
  const { password, passkey } = useAuthMutations()
  const [secret, setSecret] = useState('')
  const methods = auth.methods
  const hasPassword = methods.some((m) => m.kind === 'password')
  const hasPasskey = methods.some((m) => m.kind === 'passkey')
  const oidc = methods.flatMap((m) => (m.kind === 'oidc' ? [m] : []))
  const others = hasPasskey || oidc.length > 0
  const cancelled = isCancelled(passkey.error)
  const error = password.error ?? (cancelled ? null : passkey.error)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (secret) password.mutate(secret)
  }

  const passwordForm = (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <TextField
        label="Password"
        type="password"
        value={secret}
        onChange={setSecret}
        autoComplete="current-password"
        autoFocus={!others}
        isRequired
      />
      <Button
        type="submit"
        variant={others ? 'secondary' : 'primary'}
        fullWidth
        isPending={password.isPending}
      >
        Sign in
      </Button>
    </form>
  )

  return (
    <AuthCard title="Sign in to Holtkeeper" subtitle="Keeps every repository in shape">
      <div className="flex flex-col gap-4">
        {cancelled ? (
          <Notice tone="danger" title="Sign-in failed">
            The passkey prompt closed before it finished. Nothing was changed.
          </Notice>
        ) : error ? (
          <Notice tone="danger" title="Sign-in failed">
            {messageOf(error)}
          </Notice>
        ) : null}

        {hasPasskey ? (
          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              fullWidth
              size="lg"
              isPending={passkey.isPending}
              onPress={() => passkey.mutate()}
            >
              <Fingerprint className="size-4" />
              {cancelled ? 'Try again' : 'Sign in with a passkey'}
            </Button>
            <p className="text-center text-xs text-muted">
              Your browser asks for Touch ID, a security key or your password manager.
            </p>
          </div>
        ) : null}

        {hasPasskey && (oidc.length || hasPassword) ? <Divider /> : null}

        {oidc.map((method) => (
          <a
            key={method.id}
            href={method.url}
            className={buttonClass(hasPasskey ? 'secondary' : 'primary', 'lg', 'w-full')}
          >
            <LogIn className="size-4" />
            {cancelled ? 'Use' : 'Continue with'} {method.label}
            {cancelled ? ' instead' : ''}
          </a>
        ))}

        {hasPassword ? (
          others ? (
            <details className="group rounded-[7px] border border-line">
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-muted hover:text-foreground">
                <KeyRound className="size-3.5" />
                Sign in with the admin password
              </summary>
              <div className="border-t border-line p-3">{passwordForm}</div>
            </details>
          ) : (
            passwordForm
          )
        ) : null}

        {methods.length === 0 ? (
          <Notice title="No sign-in methods">
            This server signs people in outside Holtkeeper. Ask your administrator how to get
            access.
          </Notice>
        ) : null}

        {hasPasskey ? (
          <div className="flex flex-col gap-2 border-t border-line pt-4 text-xs text-muted">
            <p className="flex gap-2">
              <UserPlus className="size-3.5 shrink-0" />
              New here? Accounts start from a single-use setup link. Ask your administrator for one.
            </p>
            <p className="flex gap-2">
              <LifeBuoy className="size-3.5 shrink-0" />
              Lost your passkey? An admin can send you a recovery link; your other passkeys keep
              working.
            </p>
          </div>
        ) : null}
      </div>
    </AuthCard>
  )
}
