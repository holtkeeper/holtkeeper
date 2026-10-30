/** The image type of `data` by its signature; `undefined` for anything else. */
export function imageType(data: Uint8Array): string | undefined {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte)
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...data.slice(8, 12)) === 'WEBP')
    return 'image/webp'
  const head = new TextDecoder().decode(data.slice(0, 512)).trimStart()
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml'
  return undefined
}
