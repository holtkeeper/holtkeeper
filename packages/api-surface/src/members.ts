const memberLine = /^\s*(?:readonly\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\??\s*[:(<]/

const goIdent = '[\\p{L}_][\\p{L}\\p{N}_]*'
const goDeclaration = new RegExp(
  `^type\\s+${goIdent}(?:\\[[^\\]]*\\])?\\s+(?:struct|interface)\\s*\\{`,
  'u',
)
const goMethod = new RegExp(`^\\s*(${goIdent})\\s*\\(`, 'u')
const goFields = new RegExp(`^\\s*(${goIdent}(?:\\s*,\\s*${goIdent})*)\\s+[^\\s/]`, 'u')
const goEmbedded = new RegExp(
  `^\\s*\\*?(?:${goIdent}\\.)?(${goIdent})(?:\\[.*\\])?\\s*(?:\x60[^\x60]*\x60)?\\s*$`,
  'u',
)

/** Member names one line of a Go struct or interface body declares: fields, methods or embeds. */
function goMembers(line: string): string[] {
  if (/^\s*(?:\/\/|~)/.test(line)) return []
  const method = goMethod.exec(line)?.[1]
  if (method) return [method]
  const fields = goFields.exec(line)?.[1]
  if (fields) return fields.split(',').map((name) => name.trim())
  const embedded = goEmbedded.exec(line)?.[1]
  return embedded ? [embedded] : []
}

/**
 * Names of the members a declaration lists one per line, e.g. an interface's properties; for a Go
 * `type X struct {…}` or `type X interface {…}`, its field names (embedded types by their type
 * name) and interface methods.
 */
export function declaredMembers(signature: string | undefined): Set<string> {
  const names = new Set<string>()
  if (!signature) return names
  const go = goDeclaration.test(signature)
  let depth = 0
  for (const line of signature.split('\n')) {
    if (depth === 1 && go) for (const name of goMembers(line)) names.add(name)
    const match = depth === 1 && !go ? memberLine.exec(line) : null
    if (match?.[1]) names.add(match[1])
    for (const char of line) {
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
    }
  }
  return names
}
