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

/**
 * The files of the package registries of the GitLab at `url` whose content does not change once
 * published, for caching proxies: npm tarballs, Maven files of release versions (not
 * `maven-metadata.xml` or `-SNAPSHOT`), PyPI files (their sha256 is in the path) and generic
 * package files. Indexes and metadata never match. GitLab lets generic files be uploaded again
 * under the same version by default; a cache keeps the copy it has.
 */
export function gitlabPackageFiles(url: string): PackageRegistryLocation {
  const parsed = new URL(url)
  const base = escape(parsed.pathname.replace(/\/+$/, ''))
  const scope = `^${base}/api/v4/(projects/[^/]+/|groups/[^/]+/(-/)?)?packages`
  return {
    host: parsed.hostname,
    paths: [
      `${scope}/npm/(@[^/]+/)?[^/]+/-/(@[^/]+/)?[^/]+\\.tgz$`,
      `${scope}/maven/(?!.*-SNAPSHOT/)(?!.*/maven-metadata\\.xml)(.+/)?[^/]+\\.[A-Za-z0-9.]+$`,
      `${scope}/pypi/files/[0-9a-f]{64}/[^/]+$`,
      `${scope}/generic/[^/]+/[^/]+/[^/]+$`,
    ],
  }
}
