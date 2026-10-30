import type { RepoRef } from '@holtkeeper/forge'

import type { DocumentSource } from './contracts.ts'
import {
  outputId,
  sourceId,
  type TrackerDefinitionInput,
  trackerDefinitionSchema,
} from './definition.ts'
import { buildEntities } from './merge.ts'
import { outputs } from './outputs/index.ts'
import { evaluateRule } from './rules/index.ts'
import { sources } from './sources/index.ts'
import { errorMessage, type SourceHit, type TrackerForge } from './sources/types.ts'
import type { Finding, SourceRead, TrackerData, TrackerError } from './types.ts'

/** What a tracker run reads from and writes into its plan. */
export interface RunTrackerOptions {
  /** Forge of the repositories; `files` sources and `repo-file` outputs need it. */
  forge?: TrackerForge
  /** Forge id for change targets, e.g. `work`. */
  forgeId?: string
  /** Repositories of the analyzed group. */
  repos: RepoRef[]
  /** Name of the analyzed group. */
  group?: string
  /** Repositories of other groups, for sources that name `groups`. */
  groupRepos?: (group: string) => RepoRef[] | undefined
  /** Document sources by provider. */
  documents?: Record<string, DocumentSource>
  /** Providers that have a sink, when known, so unpublishable outputs are reported early. */
  sinkProviders?: readonly string[]
  now?: Date | (() => Date)
  /** Repositories and files read in parallel. Default 4. */
  concurrency?: number
  log?: (line: string) => void
}

/**
 * Reads every source, merges what they found into entities, applies the rules and plans the
 * outputs. Nothing is written: publications and changes are returned for `publishTracker` and
 * the change workflow. Invalid definitions throw; problems while reading are returned in `errors`.
 */
export async function runTracker(
  input: TrackerDefinitionInput,
  options: RunTrackerOptions,
): Promise<TrackerData> {
  const definition = trackerDefinitionSchema.parse(input)
  const now = typeof options.now === 'function' ? options.now() : (options.now ?? new Date())
  const concurrency = options.concurrency ?? 4
  const hits: SourceHit[] = []
  const reads: SourceRead[] = []
  const errors: TrackerError[] = []
  const documentVersions = new Map<string, number>()

  for (const [index, config] of definition.sources.entries()) {
    const id = sourceId(config, index)
    options.log?.(`tracker ${definition.id}: reading source ${id}`)
    try {
      const result = await sources[config.kind].read(config, {
        id,
        ...(options.forge ? { forge: options.forge } : {}),
        repos: options.repos,
        ...(options.group ? { group: options.group } : {}),
        ...(options.groupRepos ? { groupRepos: options.groupRepos } : {}),
        documents: options.documents ?? {},
        concurrency,
      })
      hits.push(...result.hits)
      reads.push(...result.reads)
      errors.push(...result.errors)
      for (const { provider, document } of result.documents)
        documentVersions.set(`${provider}:${document.ref}`, document.version)
    } catch (error) {
      errors.push({ source: id, message: errorMessage(error) })
    }
  }

  const entities = buildEntities(hits, definition.entity.key.normalize)
  const tracker = { id: definition.id, name: definition.name, label: definition.entity.label }
  const findings: Finding[] = []
  for (const rule of definition.rules) {
    try {
      findings.push(...evaluateRule(entities, rule, { label: tracker.label }))
    } catch (error) {
      errors.push({ message: `rule ${rule.id ?? rule.kind}: ${errorMessage(error)}` })
    }
  }

  const data: TrackerData = {
    tracker,
    generatedAt: now.toISOString(),
    entities,
    findings,
    sourcesRead: reads,
    errors,
    publications: [],
    changes: [],
  }
  for (const [index, config] of definition.outputs.entries()) {
    const id = outputId(config, index)
    try {
      const planned = await outputs[config.kind].plan(config, {
        id,
        tracker,
        entities,
        findings,
        ...(options.forge ? { forge: options.forge } : {}),
        ...(options.forgeId ? { forgeId: options.forgeId } : {}),
        documentVersions,
        ...(options.sinkProviders ? { sinkProviders: options.sinkProviders } : {}),
      })
      data.publications.push(...planned.publications)
      data.changes.push(...planned.changes)
      data.errors.push(...planned.errors)
    } catch (error) {
      data.errors.push({ output: id, message: errorMessage(error) })
    }
  }
  return data
}
