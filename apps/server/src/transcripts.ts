import { type Transcript, type TranscriptLine, parseTranscript } from '@holtkeeper/agent'
import type { ArtifactStore } from '@holtkeeper/artifacts'

/** Content type of stored agent transcripts. */
const TRANSCRIPT_TYPE = 'application/x-ndjson'

/** What a stored transcript is about; becomes the artifact's tags. */
interface TranscriptTags {
  repo: string
  taskKind: string
  job?: string
}

/** Stores `transcript` as a JSONL artifact tagged `kind: transcript`; resolves its id. */
export async function storeTranscript(
  artifacts: Pick<ArtifactStore, 'put'>,
  transcript: Transcript,
  tags: TranscriptTags,
): Promise<string> {
  const { id } = await artifacts.put(new TextEncoder().encode(transcript.toJsonl()), {
    contentType: TRANSCRIPT_TYPE,
    name: `transcript-${tags.taskKind}.jsonl`,
    tags: { kind: 'transcript', ...tags },
  })
  return id
}

/**
 * The lines of a stored transcript; `undefined` for unknown ids and for artifacts that are not
 * transcripts, so a reference taken from a request can never read other artifacts.
 */
export async function readTranscript(
  artifacts: Pick<ArtifactStore, 'get'>,
  ref: string,
): Promise<TranscriptLine[] | undefined> {
  const artifact = await artifacts.get(ref)
  if (!artifact || artifact.tags?.['kind'] !== 'transcript') return undefined
  return parseTranscript(new TextDecoder().decode(artifact.data))
}
