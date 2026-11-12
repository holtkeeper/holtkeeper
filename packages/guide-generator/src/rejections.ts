import {
  type GuideScopeKey,
  type GuideSectionName,
  type KvStore,
  updateKv,
} from '@holtkeeper/store'
import { z } from 'zod'

/** Rejections kept per section; older ones are dropped first. */
const MAX_REJECTIONS = 50

/**
 * A person turned down one generated version of a section. It names that version by its
 * `inputHash` and `generatedAt`; the version itself stays where it is stored.
 */
export interface GuideRejection {
  inputHash: string
  generatedAt: string
  by: string
  at: string
}

const rejectionsSchema = z.array(
  z.object({
    inputHash: z.string(),
    generatedAt: z.string(),
    by: z.string(),
    at: z.string(),
  }),
)

/** `Store.kv` key of one section's rejections. */
const guideRejectionsKey = (scope: GuideScopeKey, section: GuideSectionName) =>
  `guide:rejected:${scope}:${section}`

/** The section's rejections, oldest first; empty without a key-value store. */
export async function guideRejections(
  kv: Pick<KvStore, 'get'> | undefined,
  scope: GuideScopeKey,
  section: GuideSectionName,
): Promise<GuideRejection[]> {
  if (!kv) return []
  const parsed = rejectionsSchema.safeParse(await kv.get(guideRejectionsKey(scope, section)))
  return parsed.success ? parsed.data : []
}

/** Hashes of the section's rejected versions. */
export const rejectedHashes = async (
  kv: Pick<KvStore, 'get'> | undefined,
  scope: GuideScopeKey,
  section: GuideSectionName,
): Promise<Set<string>> =>
  new Set((await guideRejections(kv, scope, section)).map((rejection) => rejection.inputHash))

/**
 * Remembers a rejection, replacing an earlier one of the same hash. `false` when concurrent writes
 * kept it from landing.
 */
export async function rememberGuideRejection(
  kv: KvStore,
  scope: GuideScopeKey,
  section: GuideSectionName,
  rejection: GuideRejection,
): Promise<boolean> {
  const written = await updateKv(kv, guideRejectionsKey(scope, section), (before) => {
    const parsed = rejectionsSchema.safeParse(before)
    return [
      ...(parsed.success ? parsed.data : []).filter(
        (each) => each.inputHash !== rejection.inputHash,
      ),
      rejection,
    ].slice(-MAX_REJECTIONS)
  })
  return written !== undefined
}
