import { type CitedRule, citedRules } from './citations.ts'

/**
 * How a posted note shows the rules and learnings it cites: `link` makes each citation a link to
 * the rule with its title as the tooltip, `details` also appends each cited rule in a collapsed
 * block, `off` shows nothing.
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

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

const tooltip = (title: string) => oneLine(title).replace(/["\\]/g, "'")

/**
 * `text` with every `[rule:<id>]` and `[learn:<id>]` shown in `style`: the citation itself as the
 * text of a link to the rule, titled with the rule's name (as it is when the rule has no `url`).
 * A citation that is not shown stays in the note as a hidden comment, so `citedRules` still finds
 * it in the posted note whatever the style. A citation `known` lacks is not shown.
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
    if (style === 'details' && !seen.has(key)) {
      seen.add(key)
      appended.push(
        `<details><summary>${key}: ${oneLine(info.title)}</summary>\n\n${info.text.trim()}\n\n</details>`,
      )
    }
    return info.url ? ` [\\[${key}\\]](${info.url} "${tooltip(info.title)}")` : ` [${key}]`
  })
  return [body.replace(/[ \t]*\(\s*(<!-- \[[^\]]+\] -->)\s*\)/g, '$1'), ...appended].join('\n\n')
}

const LINKED = /\[\\\[((?:rule|learn):[\w-]+)\\\]\]\(\S+ "[^"]*"\)/g

/**
 * `text` of a posted note with the citation links `renderCitations` made turned back into plain
 * `[rule:<id>]` and `[learn:<id>]`, as the agent wrote them: what an agent reading the note gets.
 */
export function plainCitations(text: string): string {
  return text.replace(LINKED, '[$1]')
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
