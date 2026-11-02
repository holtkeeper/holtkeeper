/** A command a person typed: its name and the words after it. */
export interface CommandLine {
  name: string
  /** Words after the name; double-quoted words keep their spaces, without the quotes. */
  args: string[]
}

/** Splits text into words; `"..."` keeps spaces, `\"` is a quote inside it. */
export function splitWords(text: string): string[] {
  const words: string[] = []
  let current = ''
  let quoted = false
  let started = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? ''
    if (quoted && char === '\\' && text[index + 1] === '"') {
      current += '"'
      index++
    } else if (char === '"') {
      quoted = !quoted
      started = true
    } else if (!quoted && /\s/.test(char)) {
      if (started) words.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started) words.push(current)
  return words
}

/**
 * The `/<prefix> <name> [args]` command of a message, from its first line that has one; with
 * `bare`, also a message that starts with the name itself (a direct message to the bot, a button).
 * Names are lowercase words with `-` and `_`.
 */
export function parseCommandLine(
  text: string,
  options: { prefix?: string; bare?: boolean } = {},
): CommandLine | undefined {
  const prefix = options.prefix ?? 'holtkeeper'
  const marker = new RegExp(`^\\s*/${prefix}\\s+([a-z][\\w-]*)(.*)$`)
  for (const line of text.split('\n')) {
    const match = marker.exec(line)
    if (match?.[1]) return { name: match[1], args: splitWords(match[2] ?? '') }
  }
  if (!options.bare) return undefined
  const match = /^\s*\/?([a-z][\w-]*)(.*)$/s.exec(text)
  if (!match?.[1]) return undefined
  return { name: match[1], args: splitWords((match[2] ?? '').split('\n')[0] ?? '') }
}

/**
 * Options from command arguments: `key=value` pairs by name, `--flag` as `true`, the rest by
 * position onto `names`; when there are more positional arguments than names, the last name gets
 * the rest as a list. Positional arguments without a name are dropped.
 */
export function commandOptions(
  args: readonly string[],
  names: readonly string[] = [],
): Record<string, unknown> {
  const options: Record<string, unknown> = {}
  const positional: string[] = []
  for (const arg of args) {
    const separator = arg.indexOf('=')
    if (/^--[a-z][\w-]*$/i.test(arg)) options[arg.slice(2)] = true
    else if (separator > 0) options[arg.slice(0, separator)] = arg.slice(separator + 1)
    else positional.push(arg)
  }
  names.forEach((name, index) => {
    const isLast = index === names.length - 1
    const values = isLast ? positional.slice(index) : positional.slice(index, index + 1)
    if (values.length === 0) return
    options[name] = isLast && values.length > 1 ? values : values[0]
  })
  return options
}
