import { describe, expect, test } from 'bun:test'

import { upgradePrompt } from './upgrade-prompt.ts'

const site = (file: string, line: number, member?: string) => ({
  file,
  line,
  column: 1,
  kind: 'call' as const,
  snippet: 'spin()',
  snippetLine: line,
  ...(member ? { member } : {}),
})

describe('upgradePrompt', () => {
  test('lists the target, repositories, affected uses and quoted release notes', () => {
    const text = upgradePrompt({
      name: 'widget-kit',
      ecosystem: 'npm',
      from: '1.0.0',
      to: '2.0.0',
      repos: [{ repo: 'work:games/arcade', versions: ['1.0.0'] }],
      impact: {
        package: 'widget-kit',
        items: [
          {
            change: { change: 'removed', subpath: './motion', name: 'spin' },
            level: 'breaking',
            removedMembers: ['speed'],
            repos: [
              {
                origin: 'work:games/arcade',
                versions: ['1.0.0'],
                count: 1,
                sites: [site('src/board.ts', 12, 'reset')],
              },
            ],
            count: 1,
          },
        ],
        affected: ['work:games/arcade'],
        unaffected: ['work:tools/cli'],
      },
      changes: '## 2.0.0\n\n- Removed `spin`.',
      notes: ['No API indexed for 1.0.0'],
    })
    expect(text).toContain('# Upgrade widget-kit (npm) from 1.0.0 to 2.0.0')
    expect(text).toContain('- work:games/arcade: 1.0.0')
    expect(text).toContain('- **breaking**: removed `spin` (./motion), removed members: speed')
    expect(text).toContain('    - `src/board.ts:12` .reset')
    expect(text).toContain('No affected use in: work:tools/cli.')
    expect(text).toContain('<release-notes>\n## 2.0.0\n\n- Removed `spin`.\n</release-notes>')
    expect(text).toContain('- No API indexed for 1.0.0')
  })

  test('falls back to API changes, caps sites per repository and cuts long notes', () => {
    const text = upgradePrompt({
      name: 'shape-lib',
      to: '3.0.0',
      api: [{ change: 'changed', subpath: '.', name: 'draw', after: 'draw(): void\n  more' }],
      changes: 'x'.repeat(7000),
    })
    expect(text).toContain('# Upgrade shape-lib to 3.0.0')
    expect(text).toContain('- changed `draw`: `draw(): void`')
    expect(text).toContain('…(cut, 1000 more characters)')

    const many = upgradePrompt({
      name: 'shape-lib',
      impact: {
        package: 'shape-lib',
        items: [
          {
            change: { change: 'removed', subpath: '.', name: 'draw' },
            level: 'breaking',
            repos: [
              {
                origin: 'work:games/arcade',
                versions: [],
                count: 7,
                sites: Array.from({ length: 7 }, (_, index) => site('src/a.ts', index + 1)),
              },
            ],
            count: 7,
          },
        ],
        affected: ['work:games/arcade'],
        unaffected: [],
      },
    })
    expect(many).toContain('# Upgrade shape-lib to the latest version')
    expect(many).toContain('    - …and 2 more')
  })
})
