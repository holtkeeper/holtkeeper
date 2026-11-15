import { defineCase } from './build.ts'

/** Cases where the mistake is in a file the change did not touch. */
export const crossFileCases = [
  defineCase({
    id: 'signature-callers',
    title: 'A parameter becomes required while a caller stays as it was',
    merge: {
      title: 'Format prices with a currency',
      description: 'Adds a currency to `formatPrice`.',
    },
    files: {
      'src/report.ts': `import { formatPrice } from './money.ts'

export function reportLine(name: string, cents: number): string {
  return \`\${name}: \${formatPrice(cents)}\`
}
`,
    },
    changes: {
      'src/money.ts': {
        before: `export function formatPrice(cents: number): string {
  return (cents / 100).toFixed(2)
}
`,
        after: `export function formatPrice(cents: number, currency: string): string {
  return \`\${(cents / 100).toFixed(2)} \${currency}\`
}
`,
      },
    },
    problems: [
      {
        id: 'caller-not-updated',
        path: 'src/money.ts',
        find: 'export function formatPrice(cents: number, currency: string): string {',
        note: 'src/report.ts still calls formatPrice(cents) and now prints "undefined" as the currency.',
        mentions: [['report'], ['caller'], ['call site'], ['callsite'], ['usage']],
        minSeverity: 'major',
      },
    ],
  }),

  defineCase({
    id: 'renamed-export',
    title: 'An export is renamed but another file still imports the old name',
    merge: {
      title: 'Rename toMeters',
      description: 'Renames `toMeters` to `metersFrom` for consistency.',
    },
    files: {
      'src/route.ts': `import { toMeters } from './units.ts'

export const routeLength = (miles: number) => toMeters(miles * 1609)
`,
    },
    changes: {
      'src/units.ts': {
        before: `export function toMeters(value: number): number {
  return Math.round(value)
}
`,
        after: `export function metersFrom(value: number): number {
  return Math.round(value)
}
`,
      },
    },
    problems: [
      {
        id: 'import-broken',
        path: 'src/units.ts',
        find: 'export function metersFrom(value: number): number {',
        note: 'src/route.ts imports toMeters, which no longer exists.',
        mentions: [['route'], ['import'], ['toMeters'], ['usage'], ['caller']],
        minSeverity: 'major',
      },
    ],
  }),

  defineCase({
    id: 'unit-changed',
    title: 'A constant changes unit while its consumer still expects the old one',
    merge: {
      title: 'Timeout in seconds',
      description: 'Expresses the default timeout in seconds.',
    },
    files: {
      'src/client.ts': `import { DEFAULT_TIMEOUT } from './config.ts'

export function withTimeout(fn: () => void, timeout = DEFAULT_TIMEOUT): ReturnType<typeof setTimeout> {
  return setTimeout(fn, timeout)
}
`,
    },
    changes: {
      'src/config.ts': {
        before: `/** Default timeout in milliseconds. */
export const DEFAULT_TIMEOUT = 5000
`,
        after: `/** Default timeout in seconds. */
export const DEFAULT_TIMEOUT = 5
`,
      },
    },
    problems: [
      {
        id: 'consumer-in-ms',
        path: 'src/config.ts',
        find: 'export const DEFAULT_TIMEOUT = 5',
        note: 'src/client.ts passes it to setTimeout, which takes milliseconds: the timeout becomes 5 ms.',
        mentions: [
          ['client'],
          ['setTimeout'],
          ['millisecond'],
          ['consumer'],
          ['caller'],
          ['usage'],
        ],
        minSeverity: 'major',
      },
    ],
  }),

  defineCase({
    id: 'docs-default-differs',
    title: 'A default changes while the README keeps the old value',
    merge: {
      title: 'More retries',
      description: 'Retries failed requests five times instead of three.',
    },
    files: {
      'README.md': `# widget-client

## Options

- \`retries\` (default 3): how often a failed request is repeated.
- \`timeout\` (default 5000): milliseconds before a request is abandoned.
`,
    },
    changes: {
      'src/options.ts': {
        before: `export const defaults = {
  retries: 3,
  timeout: 5000,
}
`,
        after: `export const defaults = {
  retries: 5,
  timeout: 5000,
}
`,
      },
    },
    problems: [
      {
        id: 'readme-stale',
        path: 'src/options.ts',
        find: 'retries: 5,',
        note: 'README.md still documents a default of 3.',
        categories: ['docs', 'maintainability'],
        minSeverity: 'minor',
      },
    ],
  }),

  defineCase({
    id: 'union-not-handled',
    title: 'A new union member that an unchanged switch does not handle',
    merge: { title: 'Archived status', description: 'Adds the `archived` status for widgets.' },
    files: {
      'src/label.ts': `import type { Status } from './status.ts'

export function label(status: Status): string {
  switch (status) {
    case 'draft':
      return 'Draft'
    case 'active':
      return 'Active'
  }
}
`,
    },
    changes: {
      'src/status.ts': {
        before: `export type Status = 'draft' | 'active'
`,
        after: `export type Status = 'draft' | 'active' | 'archived'
`,
      },
    },
    problems: [
      {
        id: 'switch-gap',
        path: 'src/status.ts',
        find: "export type Status = 'draft' | 'active' | 'archived'",
        note: 'label() has no case for archived and returns undefined for it.',
        mentions: [['label'], ['switch'], ['exhaustive'], ['handle'], ['caller'], ['usage']],
        minSeverity: 'minor',
      },
    ],
  }),
]
