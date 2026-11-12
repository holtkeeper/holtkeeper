import { Dices } from 'lucide-react'

import { messageOf } from '../../api/client.ts'
import { useAccount, useSetAvatar } from '../../api/queries.ts'
import { formatDate } from '../../lib/format.ts'
import { Avatar, Button, ErrorState, KeyValue, Panel, Placeholder, notify } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

/** Account › Profile for the `users` provider: the stored name, email and avatar. */
function UserProfile() {
  const account = useAccount()
  const avatar = useSetAvatar()
  if (account.isPending) return <Placeholder className="h-28" />
  if (account.isError) return <ErrorState error={account.error} />
  const user = account.data
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-4">
        <Avatar key={user.avatarUrl} src={user.avatarUrl} name={user.name} size="lg" />
        <KeyValue
          className="min-w-0 flex-1"
          rows={[
            { label: 'Name', value: user.name },
            { label: 'Email', value: user.email ?? 'No email' },
            { label: 'Member since', value: formatDate(user.createdAt) },
            { label: 'User id', value: <span className="mono text-xs">{user.id}</span> },
          ]}
        />
        <Button
          variant="secondary"
          size="sm"
          isPending={avatar.isPending}
          onPress={() =>
            avatar.mutate(crypto.randomUUID().slice(0, 12), {
              onError: (error) => notify.error('Avatar not changed', messageOf(error)),
            })
          }
        >
          <Dices className="size-3.5" />
          New avatar
        </Button>
      </div>
    </Panel>
  )
}

/**
 * Account › Profile: who is signed in. With the `users` provider the stored profile and a new
 * random avatar; with other providers what the provider reports.
 */
export function Profile() {
  const { principal, auth } = useSession()
  if (auth.provider === 'users') return <UserProfile />
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-4">
        <Avatar src={principal.avatarUrl} name={principal.name} size="lg" />
        <KeyValue
          className="min-w-0 flex-1"
          rows={[
            { label: 'Name', value: principal.name },
            { label: 'Email', value: principal.email ?? 'No email' },
            { label: 'Signed in via', value: <span className="mono">{principal.provider}</span> },
            { label: 'User id', value: <span className="mono text-xs">{principal.id}</span> },
          ]}
        />
      </div>
      <p className="mt-3 text-xs text-muted">
        Your name and email come from how this server signs people in; change them there.
      </p>
    </Panel>
  )
}
