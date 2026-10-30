import type { Finding } from '@holtkeeper/vuln'

/** One `go get` the fixer intends to run. */
export interface GoUpgrade {
  /** Module path, such as `golang.org/x/text`. */
  module: string
  /** Target version with the `v` prefix Go expects, such as `v0.3.8`. */
  version: string
  /** Ids of the findings this upgrade is expected to fix. */
  findingIds: string[]
}

/** What the fixer would do for a set of findings, decided without touching the project. */
export interface GoUpgradePlan {
  /** At most one upgrade per module, in order of first appearance. */
  upgrades: GoUpgrade[]
  /** Reasons findings were left alone, ready for the report. */
  notes: string[]
}

const toolchainPackages = new Set(['stdlib', 'toolchain'])

const bare = (version: string) => version.replace(/^v/, '')

function compareVersions(a: string, b: string) {
  return Bun.semver.order(bare(a), bare(b))
}

/**
 * Plans module upgrades for Go findings. Each module is upgraded to the highest first fixed
 * version among its findings, and never to a version at or below the one in use. Findings for the
 * `stdlib` and `toolchain` pseudo-packages, other ecosystems and findings without a fix only
 * produce notes.
 */
export function planGoUpgrades(findings: readonly Finding[]): GoUpgradePlan {
  const upgrades = new Map<string, GoUpgrade>()
  const toolchain = new Map<string, { version: string; ids: string[] }>()
  const notes: string[] = []

  for (const finding of findings) {
    const { name, version, ecosystem } = finding.package
    if (ecosystem !== 'Go') {
      notes.push(`${finding.id}: ${name} is in ecosystem ${ecosystem}, not Go`)
      continue
    }
    const target = finding.fixedVersions[0]
    if (!target) {
      notes.push(`${finding.id}: no fixed version of ${name} is known`)
      continue
    }

    if (toolchainPackages.has(name)) {
      const entry = toolchain.get(name)
      if (!entry) toolchain.set(name, { version: target, ids: [finding.id] })
      else {
        entry.ids.push(finding.id)
        if (compareVersions(target, entry.version) > 0) entry.version = target
      }
      continue
    }

    if (compareVersions(target, version) <= 0) {
      notes.push(`${finding.id}: fixed version ${target} of ${name} is not newer than ${version}`)
      continue
    }

    const existing = upgrades.get(name)
    if (!existing) {
      upgrades.set(name, { module: name, version: `v${bare(target)}`, findingIds: [finding.id] })
      continue
    }
    existing.findingIds.push(finding.id)
    if (compareVersions(target, existing.version) > 0) existing.version = `v${bare(target)}`
  }

  for (const [name, { version, ids }] of toolchain) {
    notes.push(
      `${name}: upgrade the Go toolchain to go${bare(version)} or later (${ids.join(', ')})`,
    )
  }

  return { upgrades: [...upgrades.values()], notes }
}
