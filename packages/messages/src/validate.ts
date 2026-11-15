import { placeholdersOf, termsIn } from './catalog.ts'

const counted = (items: readonly string[]) => [...items].toSorted().join('\u0000')

const codeSpans = (text: string) => [...text.matchAll(/`[^`\n]+`/g)].map((match) => match[0])

const mentions = (text: string) =>
  [...text.matchAll(/(?<![\w@])@[\w.-]+/g)].map((match) => match[0].toLowerCase())

const links = (text: string) =>
  [...text.matchAll(/\b(?:https?:\/\/|www\.)[^\s)>\]]+/gi)].map((match) => match[0].toLowerCase())

/**
 * Why `translation` cannot stand in for `source`, or `undefined` when it can. A translation must
 * be non-empty and not much longer than the source, keep the same placeholders and code spans, and
 * add no HTML comments (the bot's own markers), mentions or links the source lacks, so a bad
 * translation can neither break formatting nor ping people. With `terms`, every term the source
 * uses must appear in it too.
 */
export function translationProblem(
  source: string,
  translation: string,
  terms: readonly string[] = [],
): string | undefined {
  const text = translation.trim()
  if (!text) return 'the translation is empty'
  if (text.length > Math.max(source.length * 4, source.length + 200))
    return 'the translation is much longer than the English text'
  if (counted(placeholdersOf(text)) !== counted(placeholdersOf(source)))
    return `the translation must keep the placeholders ${
      placeholdersOf(source)
        .map((name) => `{${name}}`)
        .join(', ') || '(none)'
    } exactly`
  if (counted(codeSpans(text)) !== counted(codeSpans(source)))
    return 'the translation must keep every `code` span unchanged'
  if ((text.includes('<!--') || text.includes('-->')) && !source.includes('<!--'))
    return 'the translation must not contain HTML comments'
  const sourceMentions = new Set(mentions(source))
  if (mentions(text).some((mention) => !sourceMentions.has(mention)))
    return 'the translation must not mention people'
  const sourceLinks = new Set(links(source))
  if (links(text).some((link) => !sourceLinks.has(link)))
    return 'the translation must not add links'
  const lost = termsIn(source, terms).filter((term) => !termsIn(text, [term]).length)
  if (lost.length) return `the translation must keep ${lost.join(', ')} in English`
  return undefined
}
