import type { PublicApiPackageSummary } from '@holtkeeper/api'
import { packageSubject } from '@holtkeeper/knowledge'
import type { FleetPackage } from '@holtkeeper/knowledge-bootstrap'

/**
 * The library subjects fleet repositories own, from the public API catalog: one per package its
 * repository still has (`removed` ones are left out), npm by package name and Go by module path
 * (`Go:<module>`), so a dependency subject of another repository finds its home.
 */
export function fleetPackagesOf(
  packages: readonly Pick<
    PublicApiPackageSummary,
    'name' | 'ecosystem' | 'module' | 'repo' | 'removed'
  >[],
): FleetPackage[] {
  return packages
    .filter((pkg) => !pkg.removed)
    .map((pkg) => ({
      subject: packageSubject({
        ecosystem: pkg.ecosystem ?? 'npm',
        name: pkg.ecosystem === 'Go' ? (pkg.module ?? pkg.name) : pkg.name,
      }),
      repo: pkg.repo,
    }))
}
