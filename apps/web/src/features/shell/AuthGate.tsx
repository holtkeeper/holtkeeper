import { ApiError, messageOf } from '../../api/client.ts'
import { useMe } from '../../api/queries.ts'
import { Button, Loading } from '../../ui/index.ts'
import { LoginPage } from '../auth/LoginPage.tsx'
import { AppShell } from './AppShell.tsx'
import { SessionContext } from './session.ts'

function Unreachable({
  error,
  retrying,
  onRetry,
}: {
  error: Error
  retrying: boolean
  onRetry: () => void
}) {
  const status = error instanceof ApiError ? String(error.status) : 'offline'
  return (
    <div className="grid min-h-screen place-items-center bg-background px-4">
      <div
        role="alert"
        className="flex w-full max-w-md flex-wrap items-center gap-3 rounded-[10px] border border-line bg-panel px-4 py-3 text-sm"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-danger" />
          <span className="min-w-0">
            <span className="font-medium">Could not reach the server</span>
            <span className="block truncate text-xs text-muted" title={messageOf(error)}>
              <span className="mono">{status} · /api/me</span> · {messageOf(error)}
            </span>
          </span>
        </span>
        <Button variant="secondary" size="sm" isPending={retrying} onPress={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  )
}

/**
 * Shows the sign-in page until `/api/me` returns a principal, then the app shell; when `/api/me`
 * fails, the status and a Retry button.
 */
export function AuthGate() {
  const me = useMe()
  if (me.isPending) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Loading label="Starting Holtkeeper" />
      </div>
    )
  }
  if (me.isError)
    return (
      <Unreachable error={me.error} retrying={me.isFetching} onRetry={() => void me.refetch()} />
    )
  const { principal, auth, crossTeam } = me.data
  if (!principal) return <LoginPage auth={auth} />
  return (
    <SessionContext value={{ principal, auth, crossTeam }}>
      <AppShell />
    </SessionContext>
  )
}
