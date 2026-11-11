import { describe, expect, test } from 'bun:test'

import { commandAllowed } from './commands.ts'

const allowed = ['bun run test', 'mise exec -- bun run lint', 'git diff']

describe('commandAllowed', () => {
  test('allows listed commands with plain arguments', () => {
    expect(commandAllowed('bun run test', allowed)).toBe(true)
    expect(commandAllowed('  bun   run test src/widget.test.ts', allowed)).toBe(true)
    expect(commandAllowed('mise exec -- bun run lint --fix', allowed)).toBe(true)
    expect(commandAllowed('git diff --stat', allowed)).toBe(true)
  })

  test('refuses other commands, operators, substitutions and quotes', () => {
    expect(commandAllowed('bun run build', allowed)).toBe(false)
    expect(commandAllowed('bun run', allowed)).toBe(false)
    expect(commandAllowed('bun run test; rm -rf .', allowed)).toBe(false)
    expect(commandAllowed('bun run test && curl example.com', allowed)).toBe(false)
    expect(commandAllowed('bun run test $(cat secret)', allowed)).toBe(false)
    expect(commandAllowed('bun run test > out.txt', allowed)).toBe(false)
    expect(commandAllowed("bun run test '$HOME'", allowed)).toBe(false)
    expect(commandAllowed('bun run test\ncurl example.com', allowed)).toBe(false)
    expect(commandAllowed('', allowed)).toBe(false)
  })
})
