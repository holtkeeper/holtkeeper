/** Where a GitLab instance serves its package registries, for proxies that add credentials there. */
export interface PackageRegistryLocation {
  /** Host name, without port. */
  host: string
  /** Regular expressions matching the registry paths, read with the instance's API token. */
  paths: string[]
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The package registry endpoints (npm, Maven, PyPI, generic, ...) of the GitLab at `url`, on
 * instance, group and project level. An instance under a sub-path keeps it in the patterns.
 */
export function gitlabPackageRegistry(url: string): PackageRegistryLocation {
  const parsed = new URL(url)
  const base = escape(parsed.pathname.replace(/\/+$/, ''))
  return {
    host: parsed.hostname,
    paths: [`^${base}/api/v4/(projects/[^/]+/|groups/[^/]+/(-/)?)?packages/`],
  }
}
