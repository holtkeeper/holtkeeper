import { useMe } from '../../api/queries.ts'
import { ErrorState, Loading } from '../../ui/index.ts'
import { LoginPage } from '../auth/LoginPage.tsx'
import { AppShell } from './AppShell.tsx'
import { SessionContext } from './session.ts'

/** Shows the sign-in page until `/api/me` returns a principal, then the app shell. */
export function AuthGate() {
  const me = useMe()
  if (me.isPending) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Loading label="Starting Holtkeeper" />
      </div>
    )
  }
  if (me.isError) {
    return (
      <div className="grid min-h-screen place-items-center">
        <ErrorState error={me.error} />
      </div>
    )
  }
  const { principal, auth } = me.data
  if (!principal) return <LoginPage auth={auth} />
  return (
    <SessionContext value={{ principal, auth }}>
      <AppShell />
    </SessionContext>
  )
}
