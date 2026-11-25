import type { RepoRef } from '@holtkeeper/forge'
import { resolveSetting } from '@holtkeeper/settings'
import { z } from 'zod'

import { type ServerDeps, repoTarget } from './context.ts'

/** Setting whose `language` AI texts default to across the product. */
const aiLanguageSettingKey = 'analyzers.review'

const DEFAULT_LANGUAGE = 'English'
const languageSchema = z.object({ language: z.string().trim().min(1) })

/**
 * The language AI-written prose for `repo` defaults to: the `language` of the `analyzers.review`
 * setting that applies to the repository (scoped resolution, so a repository or team value wins
 * over the global one), else `'English'`. Never rejects on a missing or malformed setting; rejects
 * only when the settings store does. Features with a language of their own check it first.
 */
export async function aiLanguageOf(
  deps: Pick<ServerDeps, 'config' | 'store'>,
  repo: RepoRef,
): Promise<string> {
  const value = resolveSetting(
    await deps.store.settings.list(aiLanguageSettingKey),
    aiLanguageSettingKey,
    repoTarget(deps.config, repo),
  )?.value
  return languageSchema.safeParse(value).data?.language ?? DEFAULT_LANGUAGE
}
