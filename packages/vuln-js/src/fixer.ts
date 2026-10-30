import { dirname, join, normalize } from 'node:path'

import { type CommandRunner, localRunner } from '@holtkeeper/exec'
import { type Fixer, type FixRequest, type FixResult, trackChanges } from '@holtkeeper/vuln'

import { updateLockfile } from './lockfile.ts'
import { detectPackageManager, lockfileKind } from './manager.ts'
import { formatManifest, isRecord, planManifestEdits } from './manifest.ts'

export interface JsFixerOptions {
  /** Runs the package manager; defaults to local child processes. */
  runner?: CommandRunner
}

/**
 * Fixes vulnerable npm packages in `bun.lock`, `pnpm-lock.yaml`, `yarn.lock` and
 * `package-lock.json` projects by raising direct dependency ranges or adding overrides in the
 * `package.json` next to the lockfile, then regenerating the lockfile with lifecycle scripts
 * disabled. If the package manager fails, both files are restored and the error is rethrown.
 */
export function jsFixer(options: JsFixerOptions = {}): Fixer {
  const runner = options.runner ?? localRunner
  return {
    name: 'js',
    supports: (source) => lockfileKind(source) !== undefined,
    async fix(request: FixRequest): Promise<FixResult> {
      const kind = lockfileKind(request.source)
      if (!kind) throw new Error(`not a JavaScript lockfile: ${request.source}`)

      const projectRel = dirname(request.source)
      const projectDir = join(request.dir, projectRel)
      const manifestRel = normalize(join(projectRel, 'package.json'))
      const lockfileRel = normalize(request.source)
      const manifestFile = Bun.file(join(request.dir, manifestRel))

      if (!(await manifestFile.exists())) {
        return { changedFiles: [], fixed: [], notes: [`${manifestRel} not found; nothing fixed`] }
      }
      const original = await manifestFile.text()
      const manifest: unknown = JSON.parse(original)
      if (!isRecord(manifest)) throw new Error(`${manifestRel} is not a JSON object`)
      const manager = await detectPackageManager(kind, projectDir, manifest.packageManager)
      const plan = planManifestEdits(manifest, request.findings, manager)
      if (!plan.changed) return { changedFiles: [], fixed: [], notes: plan.notes }

      const lockfile = Bun.file(join(request.dir, lockfileRel))
      const originalLock = (await lockfile.exists()) ? await lockfile.arrayBuffer() : undefined
      const changedFiles = await trackChanges(request.dir, [manifestRel, lockfileRel], async () => {
        await Bun.write(manifestFile, formatManifest(original, plan.manifest))
        try {
          await updateLockfile(runner, projectDir, manager, request.signal)
        } catch (error) {
          await Bun.write(manifestFile, original)
          if (originalLock) await Bun.write(lockfile, originalLock)
          throw error
        }
      })
      return { changedFiles, fixed: plan.fixed, notes: plan.notes }
    },
  }
}
