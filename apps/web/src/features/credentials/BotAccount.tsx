import { ExternalLink, ImageUp } from 'lucide-react'
import { useRef, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useForgeAccount, useSetForgeAvatar } from '../../api/queries.ts'
import { Avatar, Button, Placeholder, buttonClass, notify } from '../../ui/index.ts'
import { AVATAR_ACCEPT, avatarFileProblem, versionedAvatarUrl } from './bot-account.ts'

/** The account behind a forge's token, with an avatar upload for `settings:write`. */
export function BotAccount({ forgeId, writable }: { forgeId: string; writable: boolean }) {
  const account = useForgeAccount(forgeId)
  const setAvatar = useSetForgeAvatar()
  const [version, setVersion] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  if (account.isPending) return <Placeholder className="h-16" />
  if (account.isError)
    return (
      <div className="rounded-xl border border-dashed border-separator p-3 text-sm text-muted">
        Bot account not read: {messageOf(account.error)}
      </div>
    )
  const { name, username, webUrl, settingsUrl, canSetAvatar } = account.data
  const src = versionedAvatarUrl(account.data.avatarUrl, version)

  const choose = async (file: File | undefined) => {
    if (!file) return
    const problem = await avatarFileProblem(file)
    if (problem) {
      notify.error('Not uploaded', problem)
      return
    }
    setAvatar.mutate(
      { forgeId, file },
      {
        onSuccess: () => {
          setVersion(Date.now())
          notify.success('Avatar updated', `@${username}`)
        },
        onError: (error) => notify.error('Not uploaded', messageOf(error)),
      },
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-default/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar key={src} src={src} name={name} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{name}</div>
            <div className="truncate font-mono text-xs text-muted">
              {webUrl ? (
                <a href={webUrl} target="_blank" rel="noreferrer" className="hover:underline">
                  @{username}
                </a>
              ) : (
                `@${username}`
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {writable && canSetAvatar ? (
            <Button
              variant="ghost"
              size="sm"
              isPending={setAvatar.isPending}
              onPress={() => input.current?.click()}
            >
              <ImageUp className="size-3.5" />
              Upload avatar
            </Button>
          ) : null}
          {settingsUrl ? (
            <a
              href={settingsUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonClass('ghost', 'sm')}
            >
              <ExternalLink className="size-3.5" />
              Profile settings
            </a>
          ) : null}
        </div>
      </div>
      {settingsUrl ? (
        <span className="text-xs text-muted">
          The token cannot change the name or username; change them in the profile settings on the
          forge.
        </span>
      ) : null}
      {writable && canSetAvatar ? (
        <input
          ref={input}
          type="file"
          accept={AVATAR_ACCEPT}
          className="hidden"
          onChange={(event) => {
            void choose(event.target.files?.[0])
            event.target.value = ''
          }}
        />
      ) : null}
    </div>
  )
}
