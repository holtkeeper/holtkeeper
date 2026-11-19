/** What a citation points at. */
type CitationKind = 'rule' | 'learn' | 'pkg' | 'file' | 'doc' | 'url'

/** A source an answer names as `[kind:value]`. */
export interface Citation {
  kind: CitationKind
  /** What follows the kind: an id, `name@version export`, `repo path:line`, a URL. */
  value: string
  /** The citation as written, brackets included. */
  text: string
}

/** An answer with its citations sorted by whether the evidence backs them. */
export interface CheckedAnswer {
  /** The answer with every unbacked citation replaced by `[unverified]`. */
  text: string
  /** Backed citations, each once, in order of first use. */
  verified: Citation[]
  /** Citations nothing in the evidence backs, each once. */
  dropped: Citation[]
}

const CITATION = /\[(rule|learn|pkg|file|doc|url):\s*([^\]\n]+?)\s*\]/g

/** The `[kind:value]` citations of `text` in order, repeats included. */
export function citationsIn(text: string): Citation[] {
  return [...text.matchAll(CITATION)].map((match) => ({
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the pattern only matches these kinds
    kind: match[1] as CitationKind,
    value: match[2] ?? '',
    text: match[0],
  }))
}

const LINE_SUFFIX = /^(.+?):\d+(?:-\d+)?$/

/**
 * Whether one space-separated part of a citation appears in `evidence`: verbatim, as a path
 * whose `:line` suffix the evidence need not repeat, or as `name@version` whose two halves both
 * appear.
 */
function atomBacked(atom: string, evidence: string): boolean {
  if (evidence.includes(atom)) return true
  const path = LINE_SUFFIX.exec(atom)?.[1]
  if (path && /[/.]/.test(path) && evidence.includes(path)) return true
  const at = atom.lastIndexOf('@')
  if (at > 0 && at < atom.length - 1)
    return evidence.includes(atom.slice(0, at)) && evidence.includes(atom.slice(at + 1))
  return false
}

/**
 * Whether `evidence` backs `citation`: a rule or learned rule by its `rule:<id>` or `learn:<id>`
 * form, anything else by every space-separated part of its value (see `atomBacked`). A citation
 * is backed by text the tools returned, never by the answer itself.
 */
export function citationBacked(citation: Citation, evidence: string): boolean {
  if (citation.kind === 'rule' || citation.kind === 'learn')
    return evidence.includes(`${citation.kind}:${citation.value}`)
  const atoms = citation.value.split(/\s+/).filter(Boolean)
  return atoms.length > 0 && atoms.every((atom) => atomBacked(atom, evidence))
}

/**
 * Checks every citation of `answer` against `evidence` (the texts the answering run read):
 * backed ones stay, the others become `[unverified]` so the reader sees which statements lost
 * their source.
 */
export function checkAnswer(answer: string, evidence: readonly string[]): CheckedAnswer {
  const all = evidence.join('\n')
  const verified = new Map<string, Citation>()
  const dropped = new Map<string, Citation>()
  const text = answer.replace(CITATION, (whole, kind: CitationKind, value: string) => {
    const citation: Citation = { kind, value, text: whole }
    const key = `${kind}:${value}`
    if (citationBacked(citation, all)) {
      if (!verified.has(key)) verified.set(key, citation)
      return whole
    }
    if (!dropped.has(key)) dropped.set(key, citation)
    return '[unverified]'
  })
  return { text, verified: [...verified.values()], dropped: [...dropped.values()] }
}
