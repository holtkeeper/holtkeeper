import { go } from './go.ts'
import { java } from './java.ts'
import { javascript, typescript } from './javascript.ts'
import { kotlin } from './kotlin.ts'
import { php } from './php.ts'
import { python } from './python.ts'
import { rust } from './rust.ts'
import type { LanguageSpec } from './types.ts'

export { go, java, javascript, kotlin, php, python, rust, typescript }
export type * from './types.ts'

/** Every language the conventions check knows. */
export const defaultLanguages: readonly LanguageSpec[] = [
  typescript,
  javascript,
  go,
  python,
  rust,
  java,
  kotlin,
  php,
]
