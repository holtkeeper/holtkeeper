import { defineCase } from './build.ts'

/** Changes with nothing to report: any comment on them is noise. */
export const cleanCases = [
  defineCase({
    id: 'clean-local-rename',
    title: 'Behavior-preserving rename of a local variable',
    merge: {
      title: 'Clearer names',
      description: 'Renames `x` to `width` in `area`. No behavior change.',
    },
    changes: {
      'src/area.ts': {
        before: `export function area(x: number, height: number): number {
  return x * height
}
`,
        after: `export function area(width: number, height: number): number {
  return width * height
}
`,
      },
    },
  }),

  defineCase({
    id: 'clean-tested-helper',
    title: 'A correct helper with its test',
    merge: { title: 'Clamp helper', description: 'Adds `clamp` and tests for its boundaries.' },
    changes: {
      'src/clamp.ts': {
        after: `/** Limits \`value\` to the range from \`min\` to \`max\`, both inclusive. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
`,
      },
      'src/clamp.test.ts': {
        after: `import { expect, test } from 'bun:test'

import { clamp } from './clamp.ts'

test('keeps values inside the range', () => {
  expect(clamp(5, 0, 10)).toBe(5)
})

test('limits at both ends', () => {
  expect(clamp(-1, 0, 10)).toBe(0)
  expect(clamp(11, 0, 10)).toBe(10)
  expect(clamp(0, 0, 10)).toBe(0)
  expect(clamp(10, 0, 10)).toBe(10)
})
`,
      },
    },
  }),

  defineCase({
    id: 'clean-comment-only',
    title: 'A comment gets clearer',
    merge: { title: 'Document retry', description: 'Explains the retry loop in a comment.' },
    changes: {
      'src/retry.ts': {
        before: `export async function retry<T>(task: () => Promise<T>, times: number): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < times; attempt++) {
    try {
      return await task()
    } catch (error) {
      last = error
    }
  }
  throw last
}
`,
        after: `// Runs \`task\` up to \`times\` times and rethrows the last error if every attempt fails.
export async function retry<T>(task: () => Promise<T>, times: number): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < times; attempt++) {
    try {
      return await task()
    } catch (error) {
      last = error
    }
  }
  throw last
}
`,
      },
    },
  }),

  defineCase({
    id: 'clean-go-checked-error',
    title: 'Go helper that handles its errors',
    merge: {
      title: 'Read a name file',
      description: 'Adds a helper that reads a file with one name.',
    },
    files: {
      'go.mod': `module example.test/widgets

go 1.22
`,
    },
    changes: {
      'name.go': {
        after: `package widgets

import (
	"fmt"
	"os"
	"strings"
)

// ReadName returns the trimmed content of the file at path.
func ReadName(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read name: %w", err)
	}
	return strings.TrimSpace(string(data)), nil
}
`,
      },
    },
    tests: false,
  }),

  defineCase({
    id: 'clean-promise-all',
    title: 'Parallel async work awaited correctly',
    merge: {
      title: 'Send mails in parallel',
      description: 'Sends the welcome mails at once and waits for all of them.',
    },
    files: {
      'src/mailer.ts': `export interface Mailer {
  send(to: string, subject: string): Promise<void>
}
`,
    },
    changes: {
      'src/welcome.ts': {
        before: `import type { Mailer } from './mailer.ts'

export async function sendWelcome(emails: string[], mailer: Mailer): Promise<number> {
  for (const email of emails) await mailer.send(email, 'Welcome!')
  return emails.length
}
`,
        after: `import type { Mailer } from './mailer.ts'

export async function sendWelcome(emails: string[], mailer: Mailer): Promise<number> {
  await Promise.all(emails.map((email) => mailer.send(email, 'Welcome!')))
  return emails.length
}
`,
      },
    },
  }),

  defineCase({
    id: 'clean-readme',
    title: 'Documentation-only change',
    merge: { title: 'Document install', description: 'Adds install instructions to the README.' },
    changes: {
      'README.md': {
        before: `# widget-client

A small client for the widget service.
`,
        after: `# widget-client

A small client for the widget service.

## Install

\`\`\`sh
bun add widget-client
\`\`\`
`,
      },
    },
  }),

  defineCase({
    id: 'clean-types-only',
    title: 'Type-only change that every user already satisfies',
    merge: {
      title: 'Optional note',
      description: 'Makes `note` of `Order` optional; every reader already checks for it.',
    },
    files: {
      'src/show.ts': `import type { Order } from './order.ts'

export const show = (order: Order) => (order.note ? \`\${order.id}: \${order.note}\` : order.id)
`,
    },
    changes: {
      'src/order.ts': {
        before: `export interface Order {
  id: string
  note: string
}
`,
        after: `export interface Order {
  id: string
  note?: string
}
`,
      },
    },
  }),

  defineCase({
    id: 'clean-no-tests-repo',
    title: 'New logic in a repository that has no tests by design',
    merge: {
      title: 'Shipping fee',
      description: 'Adds the shipping fee rules: free from 50, 5 up to 20 kg, else 12.',
    },
    changes: {
      'src/fee.ts': {
        after: `export function shippingFee(orderTotal: number, weightKg: number): number {
  if (orderTotal >= 50) return 0
  if (weightKg <= 20) return 5
  return 12
}
`,
      },
    },
    tests: false,
  }),

  defineCase({
    id: 'clean-config-json',
    title: 'A plain configuration value changes',
    merge: {
      title: 'Wider page size',
      description: 'Shows 50 rows per page instead of 25 in the widget list.',
    },
    changes: {
      'config/list.json': {
        before: `{
  "pageSize": 25,
  "sort": "name"
}
`,
        after: `{
  "pageSize": 50,
  "sort": "name"
}
`,
      },
    },
  }),

  defineCase({
    id: 'clean-fix-with-test',
    title: 'A bug fix with the regression test',
    merge: {
      title: 'Fix month label',
      description: 'Month labels showed the zero-based month; use 1-12 padded to two digits.',
    },
    changes: {
      'src/month.ts': {
        before: `export function monthLabel(date: Date): string {
  return \`\${date.getFullYear()}-\${date.getMonth()}\`
}
`,
        after: `export function monthLabel(date: Date): string {
  return \`\${date.getFullYear()}-\${String(date.getMonth() + 1).padStart(2, '0')}\`
}
`,
      },
      'src/month.test.ts': {
        after: `import { expect, test } from 'bun:test'

import { monthLabel } from './month.ts'

test('counts months from 1 and pads them', () => {
  expect(monthLabel(new Date(2024, 2, 5))).toBe('2024-03')
  expect(monthLabel(new Date(2024, 11, 31))).toBe('2024-12')
})
`,
      },
    },
  }),
]
