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

const WORD = /[A-Za-z0-9_-]/

const HEADING = /^(#{1,6})\s/

/**
 * Whether `token` stands in `line` as a whole: not inside a longer word, id, version or URL. A
 * sentence's closing punctuation after it does not count as part of it.
 */
function hasToken(line: string, token: string): boolean {
  for (let at = line.indexOf(token); at !== -1; at = line.indexOf(token, at + 1)) {
    const before = line[at - 1] ?? ''
    const after = line[at + token.length] ?? ''
    const next = line[at + token.length + 1] ?? ''
    const closes = (after === '.' || after === '/') && !WORD.test(next) && next !== '/'
    if (WORD.test(before) || before === '.') continue
    if (after === '' || closes || !(WORD.test(after) || after === '.' || after === '/')) return true
  }
  return false
}

/** One line of the evidence with the headings it stands under, outermost first. */
interface EvidenceLine {
  text: string
  headings: readonly string[]
  /** For a heading: the lines below it, up to the next heading of its level or above. */
  below?: string[]
}

/**
 * The lines of the evidence that may back a citation. A result of one line backs nothing: such
 * results are messages (nothing found, no such version) that quote what was asked for.
 */
function evidenceLines(evidence: readonly string[]): EvidenceLine[] {
  return evidence.flatMap((item) => {
    const texts = item.trim().split(/\r?\n/)
    if (texts.length < 2) return []
    const open: { level: number; line: EvidenceLine & { below: string[] } }[] = []
    return texts.map((text): EvidenceLine => {
      const level = HEADING.exec(text)?.[1]?.length
      if (level === undefined) {
        for (const heading of open) heading.line.below.push(text)
        return { text, headings: open.map((heading) => heading.line.text) }
      }
      while (open.length && (open.at(-1)?.level ?? 0) >= level) open.pop()
      for (const heading of open) heading.line.below.push(text)
      const line = { text, headings: open.map((heading) => heading.line.text), below: [] }
      open.push({ level, line })
      return line
    })
  })
}

/**
 * Whether one space-separated part of a citation is in the evidence as a whole token: verbatim,
 * as a path whose `:line` suffix the evidence need not repeat, or as `name@version` whose version
 * stands with the package: on a line that names it, under a heading that names it, or in a
 * heading whose section names it.
 */
function atomBacked(atom: string, lines: readonly EvidenceLine[]): boolean {
  if (lines.some((line) => hasToken(line.text, atom))) return true
  const path = LINE_SUFFIX.exec(atom)?.[1]
  if (path && /[/.]/.test(path) && lines.some((line) => hasToken(line.text, path))) return true
  const at = atom.lastIndexOf('@')
  if (at <= 0 || at === atom.length - 1) return false
  const name = atom.slice(0, at)
  const version = atom.slice(at + 1)
  return lines.some(
    (line) =>
      hasToken(line.text, version) &&
      (hasToken(line.text, name) ||
        line.headings.some((heading) => hasToken(heading, name)) ||
        (line.below?.some((text) => hasToken(text, name)) ?? false)),
  )
}

/**
 * Whether `evidence` (the texts the answering run read) backs `citation`: a rule or learned rule
 * by its `rule:<id>` or `learn:<id>` form, anything else by every space-separated part of its
 * value (see `atomBacked`), all as whole tokens. One-line results back nothing (see
 * `evidenceLines`). A citation is never backed by the answer itself.
 */
export function citationBacked(citation: Citation, evidence: readonly string[]): boolean {
  const lines = evidenceLines(evidence)
  if (citation.kind === 'rule' || citation.kind === 'learn')
    return lines.some((line) => hasToken(line.text, `${citation.kind}:${citation.value}`))
  const atoms = citation.value.split(/\s+/).filter(Boolean)
  return atoms.length > 0 && atoms.every((atom) => atomBacked(atom, lines))
}

/**
 * Checks every citation of `answer` against `evidence`: backed ones stay, the others become
 * `[unverified]` so the reader sees which statements lost their source.
 */
export function checkAnswer(answer: string, evidence: readonly string[]): CheckedAnswer {
  const verified = new Map<string, Citation>()
  const dropped = new Map<string, Citation>()
  const text = answer.replace(CITATION, (whole, kind: CitationKind, value: string) => {
    const citation: Citation = { kind, value, text: whole }
    const key = `${kind}:${value}`
    if (verified.has(key)) return whole
    if (!dropped.has(key) && citationBacked(citation, evidence)) {
      verified.set(key, citation)
      return whole
    }
    dropped.set(key, citation)
    return '[unverified]'
  })
  return { text, verified: [...verified.values()], dropped: [...dropped.values()] }
}
