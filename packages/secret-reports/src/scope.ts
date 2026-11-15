/**
 * The host of `service` in lower case when it is a URL or a host name (`https://api.example.com/x`,
 * `api.example.com:8443`), otherwise the trimmed name in lower case (`payments-db`).
 */
export function serviceName(service: string): string {
  const trimmed = service.trim().toLowerCase()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const host = new URL(withScheme).hostname
    if (host.includes('.') || host === 'localhost') return host
  } catch {
    // Not a URL: a plain service name.
  }
  return trimmed
}

/**
 * Whether `service` belongs to one of `patterns`, the organization's services:
 * - `example.com` covers that host and every subdomain;
 * - `*.example.com` covers subdomains only;
 * - a name without dots (`payments-db`) covers exactly that name.
 * Matching ignores case, schemes, ports and paths.
 */
export function matchesService(service: string, patterns: readonly string[]): boolean {
  const name = serviceName(service)
  if (!name) return false
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase()
    if (!pattern) return false
    if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1))
    const host = serviceName(pattern)
    return name === host || (host.includes('.') && name.endsWith(`.${host}`))
  })
}
