import type { EffectiveToolchain, Toolchain, ToolchainOverride } from './types.ts'

/**
 * Applies the scoped `toolchain` setting to a detected toolchain: listed tools replace detected
 * versions (source `setting`, `none` removes the tool), new ones are appended; `image`, `network`
 * and `env` are taken from the override. The inputs are not changed.
 */
export function mergeToolchain(
  detected: Toolchain,
  override: ToolchainOverride | undefined,
): EffectiveToolchain {
  const replacements = override?.tools ?? {}
  const tools = detected.tools
    .filter((tool) => replacements[tool.name] !== 'none')
    .map((tool) => {
      const version = replacements[tool.name]
      return version === undefined ? tool : { name: tool.name, version, source: 'setting' }
    })
  for (const [name, version] of Object.entries(replacements)) {
    if (version !== 'none' && !tools.some((tool) => tool.name === name))
      tools.push({ name, version, source: 'setting' })
  }

  let packageManager = detected.packageManager
  const managerVersion = packageManager && replacements[packageManager.name]
  if (packageManager && managerVersion && managerVersion !== 'none')
    packageManager = { name: packageManager.name, version: managerVersion }

  return {
    tools,
    ...(packageManager && { packageManager }),
    notes: [...detected.notes],
    ...(override?.image !== undefined && { image: override.image }),
    ...(override?.network !== undefined && { network: override.network }),
    env: { ...override?.env },
  }
}

/** `mise exec node@20 pnpm@9.12.0 --`: the prefix that runs a command with the toolchain's tools. */
export function miseExecArgs(toolchain: Pick<Toolchain, 'tools'>): string[] {
  return ['mise', 'exec', ...miseToolSpecs(toolchain), '--']
}

/** `node@20`, `pnpm@9.12.0`, ...: the toolchain's tools as mise tool arguments. */
export function miseToolSpecs(toolchain: Pick<Toolchain, 'tools'>): string[] {
  return toolchain.tools.map((tool) => `${tool.name}@${tool.version}`)
}
