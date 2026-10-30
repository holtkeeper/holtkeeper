import { type DocumentSink, isVersionConflict } from './contracts.ts'
import { errorMessage } from './sources/types.ts'
import type { Publication, TrackerData } from './types.ts'

/** What happened to one publication. */
export interface PublicationOutcome {
  output: string
  provider?: string
  ref?: string
  markerId?: string
  /**
   * `published`: written; `unchanged`: the section already had this content; `conflict`: the
   * document changed since the analysis read it, nothing was written; `skipped`: no sink or not
   * a document publication; `failed`: the sink rejected for another reason.
   */
  status: 'published' | 'unchanged' | 'conflict' | 'skipped' | 'failed'
  version?: number
  url?: string
  message?: string
}

export interface PublishResult {
  outcomes: PublicationOutcome[]
  published: number
  conflicts: number
  failed: number
}

export interface PublishOptions {
  /** Sinks by provider. */
  sinks: Record<string, DocumentSink>
  /** Only these output ids; all when omitted. */
  outputs?: readonly string[]
}

async function publishOne(
  publication: Publication,
  sinks: Record<string, DocumentSink>,
): Promise<PublicationOutcome> {
  const base = {
    output: publication.output,
    ...(publication.provider ? { provider: publication.provider } : {}),
    ...(publication.ref ? { ref: publication.ref } : {}),
    ...(publication.markerId !== undefined ? { markerId: publication.markerId } : {}),
  }
  if (!publication.provider || !publication.ref || publication.format === 'text')
    return { ...base, status: 'skipped', message: 'not a document publication' }
  const sink = sinks[publication.provider]
  if (!sink)
    return {
      ...base,
      status: 'skipped',
      message: `no document sink for provider ${publication.provider}`,
    }
  try {
    const result = await sink.replaceSection(publication.ref, {
      markerId: publication.markerId ?? '',
      content: publication.content,
      format: publication.format,
      ...(publication.expectedVersion === undefined
        ? {}
        : { expectedVersion: publication.expectedVersion }),
      ...(publication.title ? { message: publication.title } : {}),
    })
    return {
      ...base,
      status: result.changed ? 'published' : 'unchanged',
      version: result.version,
      url: result.url,
    }
  } catch (error) {
    if (isVersionConflict(error))
      return {
        ...base,
        status: 'conflict',
        message: `the document changed since the analysis read version ${publication.expectedVersion ?? '?'}; run the tracker again before publishing (${errorMessage(error)})`,
      }
    return { ...base, status: 'failed', message: errorMessage(error) }
  }
}

/**
 * Executes the document publications a run planned, one after another; notifications (no
 * provider) are left to their consumers. A version conflict is
 * reported and that document left untouched; other publications still run. Never throws.
 */
export async function publishTracker(
  data: Pick<TrackerData, 'publications'>,
  options: PublishOptions,
): Promise<PublishResult> {
  const outcomes: PublicationOutcome[] = []
  for (const publication of data.publications) {
    if (!publication.provider) continue
    if (options.outputs && !options.outputs.includes(publication.output)) continue
    outcomes.push(await publishOne(publication, options.sinks))
  }
  return {
    outcomes,
    published: outcomes.filter((outcome) => outcome.status === 'published').length,
    conflicts: outcomes.filter((outcome) => outcome.status === 'conflict').length,
    failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
  }
}
