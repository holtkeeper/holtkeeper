import type { RepoRef } from '@holtkeeper/api'
import { ImageUp, RotateCcw } from 'lucide-react'
import { useRef, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { api } from '../../api/endpoints.ts'
import {
  useRepoAvatarInfo,
  useRepoAvatarMutations,
  useRepoAvatarVersion,
} from '../../api/queries.ts'
import { repoInitials } from '../../lib/repo.ts'
import { Button, Tooltip, notify } from '../../ui/index.ts'

const sizes = {
  sm: 'size-6 rounded-md text-[10px]',
  md: 'size-9 rounded-lg text-xs',
  lg: 'size-13 rounded-2xl text-base',
} as const

/**
 * A repository's avatar: its uploaded image, the forge's project or group avatar, or generated
 * initials, all served by `GET /api/repos/avatar`. Falls back to plain initials if loading fails.
 */
export function RepoAvatar({
  repo,
  size = 'md',
  className = '',
}: {
  repo: RepoRef
  size?: keyof typeof sizes
  className?: string
}) {
  const version = useRepoAvatarVersion(repo)
  const [failed, setFailed] = useState<string>()
  const src = api.repoAvatarUrl(repo, version)
  const box = `${sizes[size]} shrink-0 overflow-hidden shadow-surface ${className}`
  if (failed === src)
    return (
      <span
        aria-hidden
        className={`${box} grid place-items-center bg-default font-semibold text-muted`}
      >
        {repoInitials(repo.path)}
      </span>
    )
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(src)}
      className={`${box} bg-default object-cover`}
    />
  )
}

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'
const MAX_BYTES = 512 * 1024

const sourceText = {
  custom: 'Uploaded in the panel',
  forge: 'From the forge (project or group avatar)',
  generated: 'Generated from the path',
} as const

/** The large avatar of a repository page, with upload and reset for `settings:write`. */
export function RepoAvatarEditor({ repo, writable }: { repo: RepoRef; writable: boolean }) {
  const info = useRepoAvatarInfo(repo)
  const { upload, reset } = useRepoAvatarMutations(repo)
  const input = useRef<HTMLInputElement>(null)
  const source = info.data?.source

  const choose = (file: File | undefined) => {
    if (!file) return
    if (file.size > MAX_BYTES) {
      notify.error('Too large', 'Pick an image up to 512 kB.')
      return
    }
    upload.mutate(file, {
      onSuccess: () => notify.success('Avatar updated', repo.path),
      onError: (error) => notify.error('Not uploaded', messageOf(error)),
    })
  }

  const avatar = <RepoAvatar repo={repo} size="lg" />
  if (!writable)
    return (
      <Tooltip content={source ? sourceText[source] : 'Avatar'}>
        <span tabIndex={0}>{avatar}</span>
      </Tooltip>
    )
  return (
    <div className="group relative">
      <Tooltip
        content={
          <span className="text-xs">
            {source ? sourceText[source] : 'Avatar'}. Click to upload PNG, JPEG, WebP or GIF up to
            512 kB.
          </span>
        }
      >
        <button
          type="button"
          aria-label="Upload an avatar"
          disabled={upload.isPending}
          onClick={() => input.current?.click()}
          className="relative block rounded-2xl focus-visible:outline-2 focus-visible:outline-focus"
        >
          {avatar}
          <span className="absolute inset-0 grid place-items-center rounded-2xl bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
            <ImageUp className="size-5" />
          </span>
        </button>
      </Tooltip>
      {source === 'custom' ? (
        <Button
          variant="secondary"
          size="sm"
          isIconOnly
          aria-label="Reset to the forge or generated avatar"
          isPending={reset.isPending}
          onPress={() =>
            reset.mutate(undefined, {
              onSuccess: () => notify.success('Avatar reset', repo.path),
              onError: (error) => notify.error('Not reset', messageOf(error)),
            })
          }
          className="!absolute -right-2 -bottom-2 !size-6 !min-w-6 rounded-full opacity-0 shadow-overlay transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <RotateCcw className="size-3" />
        </Button>
      ) : null}
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(event) => {
          choose(event.target.files?.[0])
          event.target.value = ''
        }}
      />
    </div>
  )
}
