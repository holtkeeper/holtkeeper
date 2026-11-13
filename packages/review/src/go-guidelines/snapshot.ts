import { type GoGuidelineSet, parseGoGuidelines } from './schema.ts'

/** Upstream tag of the snapshot shipped in `upstream/guidelines.json`. */
export const BUNDLED_GO_GUIDELINES_TAG = 'v0.1.1'

let bundled: Promise<GoGuidelineSet> | undefined

/** The guidelines shipped with Holtkeeper; the fallback whenever no refreshed copy is usable. */
export function bundledGoGuidelines(): Promise<GoGuidelineSet> {
  bundled ??= Bun.file(new URL('./upstream/guidelines.json', import.meta.url))
    .text()
    .then((raw) => ({
      tag: BUNDLED_GO_GUIDELINES_TAG,
      source: 'bundled' as const,
      guidelines: parseGoGuidelines(raw),
    }))
  return bundled
}
