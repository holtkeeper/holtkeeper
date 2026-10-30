import { Lang, parse, type SgNode } from '@ast-grep/napi'
import { z } from 'zod'

import type { Extracted } from '../types.ts'
import type { Extractor } from './types.ts'

const schema = z.object({
  kind: z.literal('ast-grep'),
  /** ast-grep pattern, e.g. `isEnabled($KEY)` or `flags.$KEY`. */
  pattern: z.string().min(1),
  /** `typescript`, `tsx`, `javascript`, `html` or `css`; default from the file extension. */
  language: z.string().min(1).optional(),
  /** Metavariable holding the key, without `$`. Default `KEY`. */
  capture: z.string().min(1).optional(),
  /** Attribute name → metavariable name, e.g. `{ fallback: 'DEFAULT' }`. */
  attrs: z.record(z.string().min(1), z.string().min(1)).optional(),
})

const byName: Record<string, Lang> = {
  typescript: Lang.TypeScript,
  ts: Lang.TypeScript,
  mts: Lang.TypeScript,
  cts: Lang.TypeScript,
  tsx: Lang.Tsx,
  javascript: Lang.JavaScript,
  js: Lang.JavaScript,
  jsx: Lang.JavaScript,
  mjs: Lang.JavaScript,
  cjs: Lang.JavaScript,
  html: Lang.Html,
  css: Lang.Css,
}

/** The parser language for a configured name or a file extension; throws when unsupported. */
function astLanguage(language: string | undefined, file: string): Lang {
  const name = (language ?? file.slice(file.lastIndexOf('.') + 1)).toLowerCase()
  const lang = byName[name]
  if (!lang) throw new Error(`ast-grep: no parser for ${language ? `language ${language}` : file}`)
  return lang
}

/** Node text without the quotes of a string literal. */
function literalText(node: SgNode): string {
  const text = node.text()
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(text)
  return quoted ? quoted[2]! : text
}

/** Code usages matched by an ast-grep pattern; the key is a captured metavariable. */
export const astGrepExtractor = {
  kind: 'ast-grep',
  schema,
  extract(text, config, context) {
    const root = parse(astLanguage(config.language, context.file), text).root()
    const capture = config.capture ?? 'KEY'
    const results: Extracted[] = []
    for (const node of root.findAll(config.pattern)) {
      const captured = node.getMatch(capture)
      if (!captured) continue
      const key = literalText(captured).trim()
      if (!key || /[\s(){}]/.test(key)) continue
      const attrs: Record<string, string> = {}
      for (const [name, variable] of Object.entries(config.attrs ?? {})) {
        const value = node.getMatch(variable)
        if (value) attrs[name] = literalText(value)
      }
      results.push({ key, line: captured.range().start.line + 1, attrs })
    }
    return results
  },
} satisfies Extractor<z.output<typeof schema>>
