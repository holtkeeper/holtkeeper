import { ACCOUNT_AVATAR_EXTENSIONS, checkAccountAvatar } from '@holtkeeper/api'

/** `accept` of the avatar file input: the extensions forges take as account avatars. */
export const AVATAR_ACCEPT = ACCOUNT_AVATAR_EXTENSIONS.join(',')

/** Why `file` cannot become the bot's avatar, checked like the server does; `undefined` when it can. */
export async function avatarFileProblem(
  file: Pick<File, 'name' | 'size' | 'slice'>,
): Promise<string | undefined> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  const checked = checkAccountAvatar({ filename: file.name, size: file.size, head })
  return 'problem' in checked ? checked.problem : undefined
}

/**
 * `url` with a `v` query parameter after an upload, since forges may keep the avatar's URL when
 * the image changes; empty without a URL, so the avatar falls back to initials.
 */
export function versionedAvatarUrl(url: string | undefined, version: number): string {
  if (!url) return ''
  if (!version) return url
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('v', String(version))
    return parsed.toString()
  } catch {
    return url
  }
}
