import { defineAnalyzer } from '@holtkeeper/analyzer'
import type { RepoRef } from '@holtkeeper/forge'
import { z } from 'zod'

import type { DocumentSink, DocumentSource } from './contracts.ts'
import { type TrackerDefinitionInput, trackerDefinitionSchema } from './definition.ts'
import { runTracker } from './engine.ts'
import { trackerAnalysis } from './report.ts'
import type { TrackerData } from './types.ts'

/** Options of the `tracker` analyzer: a tracker id from settings/config, or an inline definition. */
export const trackerOptionsSchema = z
  .object({
    tracker: z.string().min(1).optional(),
    definition: trackerDefinitionSchema.optional(),
  })
  .refine((options) => options.tracker || options.definition, {
    message: 'set tracker (an id) or definition',
  })

export type TrackerOptions = z.output<typeof trackerOptionsSchema>

type MaybePromise<T> = T | Promise<T>

/** What the host provides; all optional, so a bare analyzer reads only repositories. */
export interface TrackerAnalyzerDependencies {
  /** Document sources by provider for a group (e.g. Confluence with the group's credentials). */
  documentsFor?: (repo: RepoRef) => MaybePromise<Record<string, DocumentSource>>
  /** Sinks by provider; used only to report outputs that could not be published. */
  sinksFor?: (repo: RepoRef) => MaybePromise<Record<string, DocumentSink>>
  /** Tracker definitions in effect for a group: the `trackers` setting and config. */
  definitionsFor?: (repo: RepoRef) => MaybePromise<readonly TrackerDefinitionInput[]>
  /** Repositories of a config group, for sources that name `groups`. */
  groupRepos?: (group: string) => RepoRef[] | undefined
  now?: () => Date
}

/** The `tracker` analyzer (group scope, forge API only) with injected document access. */
export function createTrackerAnalyzer(dependencies: TrackerAnalyzerDependencies = {}) {
  return defineAnalyzer<TrackerData, TrackerOptions>({
    kind: 'tracker',
    analysis: trackerAnalysis,
    scope: 'group',
    needs: { forge: true },
    options: trackerOptionsSchema,
    flags: [{ flag: 'tracker', option: 'tracker', description: 'id of the tracker to run' }],
    async run({ repo, repos, forge, options, log }) {
      let definition: TrackerDefinitionInput | undefined = options.definition
      if (!definition) {
        const known = (await dependencies.definitionsFor?.(repo)) ?? []
        definition = known.find((candidate) => candidate.id === options.tracker)
        if (!definition)
          throw new Error(
            `tracker ${options.tracker} is not defined${known.length ? `; known: ${known.map((candidate) => candidate.id).join(', ')}` : ''}`,
          )
      }
      const documents = (await dependencies.documentsFor?.(repo)) ?? {}
      const sinks = dependencies.sinksFor ? await dependencies.sinksFor(repo) : undefined
      const data = await runTracker(definition, {
        ...(forge ? { forge } : {}),
        forgeId: repo.forge,
        repos: repos ?? [],
        group: repo.path,
        ...(dependencies.groupRepos ? { groupRepos: dependencies.groupRepos } : {}),
        documents,
        ...(sinks ? { sinkProviders: Object.keys(sinks) } : {}),
        now: dependencies.now ?? (() => new Date()),
        ...(log ? { log } : {}),
      })
      return { data }
    },
  })
}

/** The `tracker` analyzer without document providers. */
export const trackerAnalyzer = createTrackerAnalyzer()
