import { type CommandRunner, runChecked } from '@holtkeeper/exec'

import { type PackageManager, lockfileUpdateCommand } from './manager.ts'

/**
 * Regenerates the lockfile in `projectDir` from its `package.json` without running lifecycle
 * scripts. Rejects with `CommandError` when the package manager fails.
 */
export async function updateLockfile(
  runner: CommandRunner,
  projectDir: string,
  manager: PackageManager,
  signal?: AbortSignal,
): Promise<void> {
  await runChecked(runner, lockfileUpdateCommand(manager), {
    cwd: projectDir,
    signal,
    // Corepack would otherwise stop and ask before downloading the pinned package manager.
    env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  })
}
