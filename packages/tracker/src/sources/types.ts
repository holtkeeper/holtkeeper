import type { GitForge, RepoRef } from '@holtkeeper/forge'
import type { z } from 'zod'

import type { DocumentContent, DocumentSource } from '../contracts.ts'
import type { Extracted, Occurrence, SourceRead, TrackerError } from '../types.ts'

/** The forge calls trackers make; they never clone. */
export type TrackerForge = Pick<GitForge, 'readFile' | 'listFiles'>

/** What a source may read from. */
export interface SourceContext {
  /** The source's id within the tracker. */
  id: string
  forge?: TrackerForge
  /** Repositories of the analyzed group; sources without `repos`/`groups` read all of them. */
  repos: RepoRef[]
  /** Name of the analyzed group, so `groups: [<it>]` needs no resolver. */
  group?: string
  /** Repositories of another config group, for sources that name `groups`. */
  groupRepos?: (group: string) => RepoRef[] | undefined
  documents: Record<string, DocumentSource>
  /** Repositories or files read in parallel. */
  concurrency: number
}

/** One raw finding of a source: the key as written plus where it was found. */
export interface SourceHit extends Extracted {
  occurrence: Omit<Occurrence, 'raw' | 'attrs' | 'line'>
}

/** What a source returns; it never throws, problems go to `errors`. */
export interface SourceResult {
  hits: SourceHit[]
  reads: SourceRead[]
  errors: TrackerError[]
  /** Documents read, so outputs writing to them can expect their version. */
  documents: { provider: string; document: DocumentContent }[]
}

/** One kind of source (`files`, `document`, ...), registered by kind. */
export interface SourceProvider<
  Config extends { kind: string; role: string } = { kind: string; role: string },
> {
  kind: Config['kind']
  schema: z.ZodType<Config>
  read(config: Config, context: SourceContext): Promise<SourceResult>
}

/** Error text of anything thrown. */
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** Maps `items` with at most `limit` calls in flight, keeping order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await map(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}
