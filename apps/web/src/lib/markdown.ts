/** Inline markdown pieces. Links only carry http(s) and mailto targets. */
export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }

/** Block markdown pieces; raw HTML is never produced, it stays text. */
export type MdBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; children: Inline[] }
  | { kind: 'rule' }

const safeHref = (href: string): string | undefined =>
  /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : undefined

/** Parses inline code, bold, italics and links; everything else is literal text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const pattern =
    /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|\[([^\]]+)\]\(([^)\s]+)\)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index
    if (index > last) out.push({ kind: 'text', text: text.slice(last, index) })
    const [whole, code, strong1, strong2, em1, em2, label, href] = match
    if (code !== undefined) out.push({ kind: 'code', text: code })
    else if (strong1 !== undefined || strong2 !== undefined)
      out.push({ kind: 'strong', children: parseInline(strong1 ?? strong2 ?? '') })
    else if (em1 !== undefined || em2 !== undefined)
      out.push({ kind: 'em', children: parseInline(em1 ?? em2 ?? '') })
    else if (label !== undefined && href !== undefined) {
      const safe = safeHref(href)
      out.push(
        safe
          ? { kind: 'link', href: safe, children: parseInline(label) }
          : { kind: 'text', text: whole },
      )
    }
    last = index + whole.length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/** Parses a small, safe markdown subset: headings, paragraphs, lists, code fences, quotes, rules. */
export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  const blocks: MdBlock[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length)
      blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join(' ')) })
    paragraph = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      flush()
      const code: string[] = []
      while (++i < lines.length && !lines[i]!.trim().startsWith('```')) code.push(lines[i]!)
      blocks.push({ kind: 'code', text: code.join('\n') })
      continue
    }
    if (!trimmed) {
      flush()
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed)
    const level = heading?.[1]?.length
    if (heading && (level === 1 || level === 2 || level === 3 || level === 4)) {
      flush()
      blocks.push({ kind: 'heading', level, children: parseInline(heading[2] ?? '') })
      continue
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flush()
      blocks.push({ kind: 'rule' })
      continue
    }
    if (trimmed.startsWith('>')) {
      flush()
      blocks.push({ kind: 'quote', children: parseInline(trimmed.replace(/^>\s?/, '')) })
      continue
    }
    const bullet = /^([-*+]|\d+[.)])\s+(.*)$/.exec(trimmed)
    if (bullet) {
      flush()
      const ordered = /\d/.test(bullet[1]!)
      const previous = blocks.at(-1)
      const item = parseInline(bullet[2]!)
      if (previous?.kind === 'list' && previous.ordered === ordered) previous.items.push(item)
      else blocks.push({ kind: 'list', ordered, items: [item] })
      continue
    }
    paragraph.push(trimmed)
  }
  flush()
  return blocks
}
