/** Largest file `setCurrentUserAvatar` accepts: GitLab's limit, the strictest of the forges. */
export const ACCOUNT_AVATAR_MAX_BYTES = 200 * 1024

const types: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
}

/** File extensions `setCurrentUserAvatar` accepts, lowercase with the dot. */
export const ACCOUNT_AVATAR_EXTENSIONS: readonly string[] = Object.keys(types)

function signatureType(head: Uint8Array): string | undefined {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => head[index] === byte)
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...head.slice(8, 12)) === 'WEBP')
    return 'image/webp'
  if (starts(0x42, 0x4d)) return 'image/bmp'
  if (starts(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon'
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) return 'image/tiff'
  return undefined
}

const extensionOf = (filename: string) => {
  const dot = filename.lastIndexOf('.')
  return dot < 0 ? '' : filename.slice(dot).toLowerCase()
}

/**
 * Whether a file may become an account avatar: at most `ACCOUNT_AVATAR_MAX_BYTES`, an extension
 * from `ACCOUNT_AVATAR_EXTENSIONS`, and contents that start like that kind of image. `head` is the
 * file or at least its first 12 bytes. Gives the image type when it may, else a sentence for the
 * person who picked the file.
 */
export function checkAccountAvatar(file: {
  filename: string
  size: number
  head: Uint8Array
}): { contentType: string } | { problem: string } {
  if (file.size === 0) return { problem: 'The image is empty.' }
  if (file.size > ACCOUNT_AVATAR_MAX_BYTES)
    return { problem: `The image is larger than ${ACCOUNT_AVATAR_MAX_BYTES / 1024} KB.` }
  const expected = types[extensionOf(file.filename)]
  const allowed = ACCOUNT_AVATAR_EXTENSIONS.join(', ')
  if (!expected) return { problem: `Use one of these file types: ${allowed}.` }
  if (signatureType(file.head) !== expected)
    return { problem: `The file is not the image its name says; use one of ${allowed}.` }
  return { contentType: expected }
}
