import { basename, dirname, join } from 'node:path'

import { type CommandRunner, localRunner, runChecked } from '@holtkeeper/exec'
import { type Finding, type Fixer, matchesId, trackChanges } from '@holtkeeper/vuln'
import { z } from 'zod'

export type UpgradeLevel = 'major' | 'minor' | 'patch'

export interface OsvFixerOptions {
  runner?: CommandRunner
  binary?: string
  /**
   * Largest version jump a fix may make. Omitted, osv-scanner's default applies (`major`).
   * In osv-scanner 2.7 lower levels can mark every advisory as unactionable for exactly pinned
   * dependencies, so restrict it only when major bumps are unacceptable.
   */
  upgrade?: UpgradeLevel
}

/** The subset of `osv-scanner fix --format json` output the fixer reads. */
const fixOutputSchema = z.object({
  vulnerabilities: z
    .array(z.object({ id: z.string(), unactionable: z.boolean().optional() }))
    .nullish(),
  patches: z.array(z.object({ fixed: z.array(z.object({ id: z.string() })).nullish() })).nullish(),
})

const covers = (ids: string[]) => (finding: Finding) => ids.some((id) => matchesId(finding, id))

interface Plan {
  args: string[]
  files: string[]
}

/**
 * Chooses the remediation strategy osv-scanner supports for a source file:
 * npm with a manifest is relaxed (manifest ranges and lockfile change), npm without one is fixed
 * in place in the lockfile, Maven gets dependency overrides in `pom.xml`.
 */
async function plan(dir: string, source: string): Promise<Plan | undefined> {
  const folder = dirname(source)
  const file = basename(source)
  if (file === 'package-lock.json') {
    const manifest = join(folder, 'package.json')
    if (await Bun.file(join(dir, manifest)).exists()) {
      return {
        args: ['--strategy', 'relax', '-M', manifest, '-L', source],
        files: [manifest, source],
      }
    }
    return { args: ['--strategy', 'in-place', '-L', source], files: [source] }
  }
  if (file === 'pom.xml') return { args: ['--strategy', 'override', '-M', source], files: [source] }
  return undefined
}

const supported = new Set(['package-lock.json', 'pom.xml'])

/**
 * A `Fixer` backed by `osv-scanner fix` (guided remediation). It covers npm lockfiles and Maven
 * `pom.xml`; other files are left to ecosystem-specific fixers.
 *
 * osv-scanner may run the package manager while fixing, so only use it on trusted checkouts.
 */
export function osvFixer({
  runner = localRunner,
  binary = 'osv-scanner',
  upgrade,
}: OsvFixerOptions = {}): Fixer {
  return {
    name: 'osv-scanner-fix',
    supports: (source) => supported.has(basename(source)),
    async fix({ dir, source, findings, signal }) {
      const strategy = await plan(dir, source)
      if (!strategy) return { changedFiles: [], fixed: [], notes: [`unsupported source ${source}`] }

      let output: z.output<typeof fixOutputSchema> = {}
      const changedFiles = await trackChanges(dir, strategy.files, async () => {
        const { stdout } = await runChecked(
          runner,
          [
            binary,
            'fix',
            ...strategy.args,
            '--format',
            'json',
            ...(upgrade ? ['--upgrade-config', upgrade] : []),
            '--no-introduce',
            ...findings.flatMap((finding) => ['--vulns', finding.id]),
          ],
          { cwd: dir, signal },
        )
        if (stdout.trim()) output = fixOutputSchema.parse(JSON.parse(stdout))
      })

      const patched = (output.patches ?? []).flatMap((patch) => patch.fixed ?? []).map((f) => f.id)
      const unactionable = (output.vulnerabilities ?? [])
        .filter((v) => v.unactionable)
        .map((v) => v.id)

      return {
        changedFiles,
        fixed: changedFiles.length ? findings.filter(covers(patched)).map((f) => f.id) : [],
        notes: findings
          .filter(covers(unactionable))
          .map((f) => `${f.id} (${f.package.name}): no ${upgrade ?? 'allowed'} upgrade fixes it`),
      }
    },
  }
}
