/** `url` when it is an absolute http(s) URL, else `undefined`; stored and third-party links go through it. */
export const httpUrl = (url: string | undefined): string | undefined => {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}
