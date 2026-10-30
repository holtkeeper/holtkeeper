import type { CodeChange } from '@holtkeeper/changes'
import type { z } from 'zod'

import type { TrackerForge } from '../sources/types.ts'
import type { Entity, Finding, Publication, TrackerError } from '../types.ts'

/** What an output may use to plan its result. */
export interface OutputContext {
  /** The output's id within the tracker. */
  id: string
  tracker: { id: string; name: string; label: string }
  entities: readonly Entity[]
  findings: readonly Finding[]
  forge?: TrackerForge
  /** Forge id for `CodeChange.target`. */
  forgeId?: string
  /** Versions of documents read during the run, by `provider:ref`. */
  documentVersions: ReadonlyMap<string, number>
  /** Providers that have a sink, when known; outputs warn about publications nobody can execute. */
  sinkProviders?: readonly string[]
}

/** What an output plans; it never writes anything itself and never throws. */
export interface OutputResult {
  publications: Publication[]
  changes: CodeChange[]
  errors: TrackerError[]
}

/** One output kind, registered by kind. */
export interface OutputProvider<Config extends { kind: string } = { kind: string }> {
  kind: Config['kind']
  schema: z.ZodType<Config>
  plan(config: Config, context: OutputContext): Promise<OutputResult>
}
