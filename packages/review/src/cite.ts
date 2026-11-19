import { type CitedRule, citedRules } from './citations.ts'

/**
 * How a posted note shows the rules and learnings it cites: `link` turns each citation into a
 * link to the rule with its text as the tooltip, `details` also appends each cited rule in a
 * collapsed block, `off` shows nothing.
 */
export type CitationStyle = 'link' | 'details' | 'off'

export const citationStyles: readonly CitationStyle[] = ['link', 'details', 'off']

/** A cited rule or learning, as a note shows it. */
export interface CitedRuleInfo {
  title: string
  /** The rule's text, markdown. */
  text: string
  /** Where people read and edit it. */
  url?: string
}

/** The key of a citation in the map `renderCitations` takes. */
export const citationKey = (cited: CitedRule) => `${cited.kind}:${cited.id}`

const CITATION = /[ \t]*\[\s*(rule|learn)\s*:\s*([A-Za-z0-9][\w-]*)\s*\](?!\s*-->)/g
const MAX_TOOLTIP = 240

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

const tooltip = (text: string) => {
  const flat = oneLine(text).replace(/["\\]/g, "'")
  return flat.length > MAX_TOOLTIP ? `${flat.slice(0, MAX_TOOLTIP - 1)}…` : flat
}

const label = (title: string) => oneLine(title).replace(/[[\]]/g, '')

/**
 * `text` with every `[rule:<id>]` and `[learn:<id>]` shown in `style`. Each citation stays in the
 * note as a hidden comment, so `citedRules` still finds it in the posted note whatever the style.
 * A citation `known` lacks is shown as nothing.
 */
export function renderCitations(
  text: string,
  style: CitationStyle,
  known: ReadonlyMap<string, CitedRuleInfo>,
): string {
  const appended: string[] = []
  const seen = new Set<string>()
  const body = text.replace(CITATION, (_match, kind: string, id: string) => {
    const key = `${kind}:${id}`
    const hidden = `<!-- [${key}] -->`
    const info = known.get(key)
    if (style === 'off' || !info) return hidden
    const title = label(info.title)
    if (style === 'details' && !seen.has(key)) {
      seen.add(key)
      appended.push(`<details><summary>📘 ${title}</summary>\n\n${info.text.trim()}\n\n</details>`)
    }
    const shown = info.url ? `[📘 ${title}](${info.url} "${tooltip(info.text)}")` : `📘 _${title}_`
    return ` ${shown}${hidden}`
  })
  return [body.replace(/[ \t]*\(\s*(<!-- \[[^\]]+\] -->)\s*\)/g, '$1'), ...appended].join('\n\n')
}

/**
 * A function that shows the citations of one note in `style`, reading what the note cites through
 * `lookup` (keyed by `citationKey`). `off` never calls `lookup`, and a failing `lookup` shows the
 * citations as nothing rather than failing the note.
 */
export function citationRenderer(
  style: CitationStyle,
  lookup?: (cited: readonly CitedRule[]) => Promise<ReadonlyMap<string, CitedRuleInfo>>,
): (text: string) => Promise<string> {
  return async (text) => {
    const cited = citedRules(text)
    if (cited.length === 0) return text
    const known =
      style === 'off' || !lookup
        ? new Map<string, CitedRuleInfo>()
        : await lookup(cited).catch(() => new Map<string, CitedRuleInfo>())
    return renderCitations(text, style, known)
  }
}
