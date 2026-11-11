const SHELL_OPERATORS = /[;&|<>`$(){}\n\r\\]/

const words = (command: string) => command.trim().split(/\s+/).filter(Boolean)

/**
 * Whether `command` may run under `allowed`: it has no shell operators, substitutions,
 * redirections or line breaks, and its words start with the words of one allowed command (so
 * `bun run test` also allows `bun run test src/widget.test.ts`, never `bun run test; rm -rf .`).
 * Quoted arguments are refused, since they could hide an operator from this check.
 */
export function commandAllowed(command: string, allowed: readonly string[]): boolean {
  if (SHELL_OPERATORS.test(command) || /["']/.test(command)) return false
  const given = words(command)
  if (given.length === 0) return false
  return allowed.some((entry) => {
    const prefix = words(entry)
    return prefix.length > 0 && prefix.every((word, index) => given[index] === word)
  })
}
