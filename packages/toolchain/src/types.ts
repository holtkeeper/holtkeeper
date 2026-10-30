import { z } from 'zod'

/** One tool a repository needs, by its mise name (`node`, `pnpm`, `go`, `python`, ...). */
export interface Tool {
  name: string
  /** A version mise understands: exact (`20.11.1`), a prefix (`20`), `lts` or `latest`. */
  version: string
  /** Repository-relative file the version came from, or `setting` for an override. */
  source: string
}

/** The tools a repository needs, detected from its version files. */
export interface Toolchain {
  /** At most one entry per tool name, in detection order. */
  tools: Tool[]
  /** The JavaScript package manager the repository uses, when one is declared or implied. */
  packageManager?: { name: string; version?: string }
  /** Human-readable remarks: ignored sources, conflicts between files and sub-projects. */
  notes: string[]
}

/** How much network the sandbox gets: none, only while installing tools, or always. */
export const networkPolicySchema = z.enum(['none', 'install', 'full'])
export type NetworkPolicy = z.output<typeof networkPolicySchema>

/** The scoped `toolchain` setting: overrides detection for the repositories in its scope. */
export const toolchainOverrideSchema = z.object({
  /** Tool versions by mise name; `none` removes a detected tool. */
  tools: z.record(z.string().min(1), z.string().min(1)).optional(),
  /** Container image for these repositories, instead of the configured one. */
  image: z.string().min(1).optional(),
  network: networkPolicySchema.optional(),
  /** Variables set for every command of a job; passed per command, never stored in an image. */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
})
export type ToolchainOverride = z.output<typeof toolchainOverrideSchema>

/** A detected toolchain with the scoped override applied. */
export interface EffectiveToolchain extends Toolchain {
  image?: string
  network?: NetworkPolicy
  env: Record<string, string>
}

/**
 * The `toolchain` setting, shaped like `SettingDefinition` from `@holtkeeper/settings` so it can be
 * registered there without this package depending on it.
 */
export const toolchainSetting = {
  key: 'toolchain',
  label: 'Toolchain',
  description:
    'Tool versions, container image, network access and environment for jobs in this scope; tools not listed keep their detected versions.',
  section: 'Runtime',
  help: `Overrides what jobs run with in this scope. Tools not listed keep the versions detected from the repository.

- Pin a tool version only when detection picks the wrong one, e.g. a monorepo with several Node versions.
- **image** replaces the job container; **network** limits what jobs may reach.
- **env** adds environment variables; store secrets in Credentials, not here.`,
  schema: toolchainOverrideSchema,
}
