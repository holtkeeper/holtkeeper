import { registerDynamicLanguage } from '@ast-grep/napi'

import type { DynamicLanguage, LanguageSpec } from './languages/types.ts'

let registration: Promise<ReadonlySet<string>> | undefined

/**
 * Registers the parsers of every dynamic language in `specs` with ast-grep and resolves with the
 * names that are usable. ast-grep accepts only one registration per process, so the first call
 * wins: later calls resolve with the first call's result. A language whose parser cannot be
 * loaded (no prebuild for this platform) is left out instead of failing the others.
 */
export function registerLanguages(specs: readonly LanguageSpec[]): Promise<ReadonlySet<string>> {
  registration ??= (async () => {
    const languages: Record<string, DynamicLanguage> = {}
    await Promise.all(
      specs.map(async (spec) => {
        if (!spec.dynamic) return
        try {
          const language = await spec.dynamic()
          // The getter resolves the prebuilt parser and throws when there is none.
          const libraryPath = language.libraryPath
          languages[String(spec.parser(`file.${spec.extensions[0]}`))] = {
            ...language,
            libraryPath,
          }
        } catch {
          // Unavailable parser: files of this language are skipped.
        }
      }),
    )
    try {
      registerDynamicLanguage(languages)
      return new Set(Object.keys(languages))
    } catch {
      return new Set<string>()
    }
  })()
  return registration
}
