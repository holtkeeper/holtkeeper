import { z } from 'zod'

import { stripInlineMarkdown, tokenizeHtml } from '../html.ts'
import type { Extracted } from '../types.ts'
import { type DocumentExtractor, headingMatches } from './types.ts'

const schema = z.object({
  kind: z.literal('list'),
  /** Only lists under a heading containing this text (case-insensitive). */
  heading: z.string().min(1).optional(),
  /**
   * Regular expression applied to each item; named group `key` (or group 1) is the key, other
   * named groups attributes. Default: the item's first code span, else its text before ` - `, `:`
   * or ` — `, with the rest as `description`.
   */
  pattern: z.string().min(1).optional(),
})

interface Item {
  heading?: string
  text: string
  code?: string
}

function htmlItems(body: string): Item[] {
  const items: Item[] = []
  let heading: string | undefined
  let headingText: string | undefined
  const open: Item[] = []
  let codeDepth = 0
  let code = ''
  for (const token of tokenizeHtml(body)) {
    if (token.type === 'text') {
      if (headingText !== undefined) headingText += token.text
      const item = open.at(-1)
      if (item) item.text += token.text
      if (codeDepth) code += token.text
    } else if (token.type === 'open') {
      if (/^h[1-6]$/.test(token.name)) headingText = ''
      else if (token.name === 'li') open.push({ ...(heading ? { heading } : {}), text: '' })
      else if (token.name === 'code' && open.length) {
        codeDepth++
        code = ''
      } else if (token.name === 'ul' || token.name === 'ol') {
        const item = open.at(-1)
        if (item) item.text += '\n'
      }
    } else if (/^h[1-6]$/.test(token.name) && headingText !== undefined) {
      heading = headingText.replace(/\s+/g, ' ').trim() || heading
      headingText = undefined
    } else if (token.name === 'code' && codeDepth) {
      codeDepth--
      const item = open.at(-1)
      if (item && item.code === undefined) item.code = code.trim()
    } else if (token.name === 'li') {
      const item = open.pop()
      if (item)
        items.push({ ...item, text: (item.text.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim() })
    }
  }
  return items
}

function markdownItems(body: string): Item[] {
  const items: Item[] = []
  let heading: string | undefined
  for (const line of body.replaceAll('\r\n', '\n').split('\n')) {
    const title = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (title) {
      heading = stripInlineMarkdown(title[1]!)
      continue
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (!item) continue
    const raw = item[1]!.replace(/^\[[ xX]\]\s+/, '')
    const code = /`([^`]+)`/.exec(raw)?.[1]
    items.push({
      ...(heading ? { heading } : {}),
      text: stripInlineMarkdown(raw),
      ...(code ? { code } : {}),
    })
  }
  return items
}

/** List items of a document, one entity per item. */
export const listExtractor = {
  kind: 'list',
  schema,
  extract(document, config) {
    const pattern = config.pattern ? new RegExp(config.pattern) : undefined
    const items =
      document.format === 'markdown' ? markdownItems(document.body) : htmlItems(document.body)
    const results: Extracted[] = []
    for (const item of items) {
      if (!headingMatches(item.heading, config.heading)) continue
      if (pattern) {
        const match = pattern.exec(item.text)
        if (!match) continue
        const { key: named, ...groups } = match.groups ?? {}
        const key = (named ?? match[1] ?? match[0]).trim()
        if (!key) continue
        const attrs: Record<string, string> = {}
        for (const [name, value] of Object.entries(groups)) if (value) attrs[name] = value.trim()
        results.push({ key, attrs })
        continue
      }
      const split = /^(.*?)\s*(?:\s[-–—]\s|:\s)\s*(.*)$/.exec(item.text)
      const key = (item.code ?? split?.[1] ?? item.text).trim()
      if (!key) continue
      const rest = item.code
        ? item.text
            .replace(item.code, '')
            .replace(/^\s*(?:[-–—:]\s*)?/, '')
            .trim()
        : (split?.[2] ?? '').trim()
      results.push({ key, attrs: rest ? { description: rest } : {} })
    }
    return results
  },
} satisfies DocumentExtractor<z.output<typeof schema>>
