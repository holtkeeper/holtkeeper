import type { AuthInfo } from '@holtkeeper/api'
import { Fingerprint, LogIn } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useAuthMutations } from '../../api/queries.ts'
import { Button, Notice, TextField, buttonClass } from '../../ui/index.ts'
import { AuthCard } from './AuthCard.tsx'

/** Sign-in page offering exactly the methods the provider lists. */
export function LoginPage({ auth }: { auth: AuthInfo }) {
  const { password, passkey } = useAuthMutations()
  const [secret, setSecret] = useState('')
  const methods = auth.methods
  const hasPassword = methods.some((m) => m.kind === 'password')
  const hasPasskey = methods.some((m) => m.kind === 'passkey')
  const oidc = methods.flatMap((m) => (m.kind === 'oidc' ? [m] : []))
  const error = password.error ?? passkey.error

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (secret) password.mutate(secret)
  }

  return (
    <AuthCard title="Sign in to Holtkeeper" subtitle="Keeps every repository in shape">
      <div className="flex flex-col gap-4">
        {error ? (
          <Notice tone="danger" title="Sign-in failed">
            {messageOf(error)}
          </Notice>
        ) : null}

        {hasPasskey ? (
          <Button
            variant="primary"
            fullWidth
            size="lg"
            isPending={passkey.isPending}
            onPress={() => passkey.mutate()}
          >
            <Fingerprint className="size-4" />
            Sign in with a passkey
          </Button>
        ) : null}

        {oidc.map((method) => (
          <a
            key={method.id}
            href={method.url}
            className={buttonClass(hasPasskey ? 'secondary' : 'primary', 'lg', 'w-full')}
          >
            <LogIn className="size-4" />
            Continue with {method.label}
          </a>
        ))}

        {hasPassword ? (
          <>
            {hasPasskey || oidc.length ? (
              <div className="flex items-center gap-3 text-xs text-muted">
                <span className="h-px flex-1 bg-separator" />
                or
                <span className="h-px flex-1 bg-separator" />
              </div>
            ) : null}
            <form onSubmit={submit} className="flex flex-col gap-3">
              <TextField
                label="Password"
                type="password"
                value={secret}
                onChange={setSecret}
                autoComplete="current-password"
                autoFocus={!hasPasskey && oidc.length === 0}
                isRequired
              />
              <Button
                type="submit"
                variant={hasPasskey || oidc.length ? 'secondary' : 'primary'}
                fullWidth
                isPending={password.isPending}
              >
                Sign in
              </Button>
            </form>
          </>
        ) : null}

        {methods.length === 0 ? (
          <Notice title="No sign-in methods">
            This server signs people in outside Holtkeeper. Ask your administrator how to get
            access.
          </Notice>
        ) : null}
      </div>
    </AuthCard>
  )
}
