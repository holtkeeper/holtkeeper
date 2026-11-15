import { defineCase } from './build.ts'

/** Cases with a plain logic mistake in new code. */
export const logicCases = [
  defineCase({
    id: 'page-skips-first',
    title: 'Pagination with 1-based pages starts at the wrong item',
    merge: {
      title: 'Add pagination helper',
      description: 'Adds `pageOf`, which returns page `page` (counting from 1) of a list.',
    },
    changes: {
      'src/page.ts': {
        after: `export interface Page<T> {
  items: T[]
  total: number
  pages: number
}

/** Returns page \`page\` (the first page is 1) of \`items\`. */
export function pageOf<T>(items: readonly T[], page: number, size: number): Page<T> {
  const start = page * size
  return {
    items: items.slice(start, start + size),
    total: items.length,
    pages: Math.ceil(items.length / size),
  }
}
`,
      },
    },
    problems: [
      {
        id: 'start-offset',
        path: 'src/page.ts',
        find: 'const start = page * size',
        note: 'Page 1 starts at item `size`, so the first page is never returned.',
        minSeverity: 'major',
      },
    ],
  }),

  defineCase({
    id: 'discount-inverted',
    title: 'Comparison is the wrong way round against the description',
    merge: {
      title: 'Member discount',
      description: 'Members get 10% off orders of 100 or more. Everyone else pays the full price.',
    },
    changes: {
      'src/discount.ts': {
        after: `/** The share taken off an order of \`total\`, 0 for none. */
export function discountFor(total: number, member: boolean): number {
  if (member && total < 100) return 0.1
  return 0
}

export function priceAfterDiscount(total: number, member: boolean): number {
  return total * (1 - discountFor(total, member))
}
`,
      },
    },
    problems: [
      {
        id: 'wrong-comparison',
        path: 'src/discount.ts',
        find: 'if (member && total < 100) return 0.1',
        note: 'Gives the discount to small orders instead of large ones.',
        minSeverity: 'major',
      },
    ],
  }),

  defineCase({
    id: 'foreach-async',
    title: 'Async callback in forEach is never awaited',
    merge: {
      title: 'Send welcome mails',
      description: 'Sends the welcome mail to every new user and returns how many were sent.',
    },
    files: {
      'src/mailer.ts': `export interface Mailer {
  send(to: string, subject: string): Promise<void>
}
`,
    },
    changes: {
      'src/welcome.ts': {
        after: `import type { Mailer } from './mailer.ts'

export interface User {
  email: string
}

export async function sendWelcome(users: User[], mailer: Mailer): Promise<number> {
  users.forEach(async (user) => {
    await mailer.send(user.email, 'Welcome!')
  })
  return users.length
}
`,
      },
    },
    problems: [
      {
        id: 'not-awaited',
        path: 'src/welcome.ts',
        find: `users.forEach(async (user) => {
    await mailer.send(user.email, 'Welcome!')
  })`,
        note: 'The function returns before any mail is sent and failures become unhandled rejections.',
        minSeverity: 'major',
      },
    ],
  }),

  defineCase({
    id: 'unknown-sku-nan',
    title: 'Non-null assertion on a lookup that can miss',
    merge: {
      title: 'Reserve stock',
      description:
        'Adds `reserve`, which takes `qty` units of a SKU out of stock and returns false when there are not enough.',
    },
    changes: {
      'src/stock.ts': {
        after: `const stock = new Map<string, number>()

export function restock(sku: string, qty: number): void {
  stock.set(sku, (stock.get(sku) ?? 0) + qty)
}

export function reserve(sku: string, qty: number): boolean {
  const have = stock.get(sku)!
  if (have < qty) return false
  stock.set(sku, have - qty)
  return true
}
`,
      },
    },
    problems: [
      {
        id: 'missing-sku',
        path: 'src/stock.ts',
        find: 'const have = stock.get(sku)!',
        note: 'An unknown SKU gives undefined; the comparison is false and NaN is stored as its stock.',
        minSeverity: 'major',
      },
    ],
  }),

  defineCase({
    id: 'shared-default-array',
    title: 'Default argument is a shared array that the function mutates',
    merge: {
      title: 'Tag helper',
      description: 'Adds `tagsFor`, which returns tags plus a version tag.',
    },
    changes: {
      'src/tags.ts': {
        after: `const DEFAULT_TAGS: string[] = ['widget']

export function tagsFor(base: string[] = DEFAULT_TAGS): string[] {
  base.push('v2')
  return base
}
`,
      },
    },
    problems: [
      {
        id: 'mutates-input',
        path: 'src/tags.ts',
        find: "base.push('v2')",
        note: 'Mutates the caller array and, by default, the shared constant, so tags pile up on every call.',
        minSeverity: 'major',
      },
    ],
  }),

  defineCase({
    id: 'save-reports-ok',
    title: 'Failure is logged but reported as success',
    merge: {
      title: 'Persist settings',
      description: 'Writes settings to disk and reports whether it worked.',
    },
    changes: {
      'src/settings.ts': {
        after: `import { writeFile } from 'node:fs/promises'

export interface Settings {
  theme: string
}

export async function saveSettings(path: string, settings: Settings): Promise<{ ok: boolean }> {
  try {
    await writeFile(path, JSON.stringify(settings))
  } catch (error) {
    console.log('could not save settings', error)
  }
  return { ok: true }
}
`,
      },
    },
    problems: [
      {
        id: 'swallowed',
        path: 'src/settings.ts',
        find: `  } catch (error) {
    console.log('could not save settings', error)
  }
  return { ok: true }`,
        note: 'A failed write still returns ok: true.',
        minSeverity: 'major',
      },
    ],
  }),

  defineCase({
    id: 'month-label',
    title: 'Zero-based month used in a label',
    merge: {
      title: 'Month labels',
      description:
        'Adds `monthLabel`, which formats a date as `YYYY-MM`, e.g. `2024-03` for March 2024.',
    },
    changes: {
      'src/month.ts': {
        after: `export function monthLabel(date: Date): string {
  return \`\${date.getFullYear()}-\${date.getMonth()}\`
}
`,
      },
    },
    problems: [
      {
        id: 'zero-based',
        path: 'src/month.ts',
        find: 'return `${date.getFullYear()}-${date.getMonth()}`',
        note: 'getMonth() is 0-based and unpadded: March 2024 becomes 2024-2.',
        minSeverity: 'major',
      },
    ],
  }),

  defineCase({
    id: 'split-bill-cents',
    title: 'Integer division loses cents',
    merge: {
      title: 'Split a bill',
      description:
        'Adds `splitBill`, which splits a bill in cents between people. The shares must add up to the bill.',
    },
    changes: {
      'src/split.ts': {
        after: `/** Splits \`totalCents\` into \`people\` shares that add up to \`totalCents\`. */
export function splitBill(totalCents: number, people: number): number[] {
  const share = Math.floor(totalCents / people)
  return Array.from({ length: people }, () => share)
}
`,
      },
    },
    problems: [
      {
        id: 'remainder-lost',
        path: 'src/split.ts',
        find: 'return Array.from({ length: people }, () => share)',
        note: 'The remainder is dropped, so 100 cents between 3 people sums to 99.',
        minSeverity: 'major',
      },
    ],
  }),

  defineCase({
    id: 'sort-numbers-default',
    title: 'Default sort on numbers, and the input is mutated',
    merge: { title: 'Top ids', description: 'Adds `topIds`, the three largest ids of a list.' },
    changes: {
      'src/top.ts': {
        after: `export function topIds(ids: number[]): number[] {
  return ids.sort().slice(-3)
}
`,
      },
    },
    problems: [
      {
        id: 'lexicographic',
        path: 'src/top.ts',
        find: 'return ids.sort().slice(-3)',
        note: 'sort() without a comparator orders numbers as strings (9 after 10) and sorts the caller array in place.',
        minSeverity: 'major',
      },
    ],
  }),

  defineCase({
    id: 'regexp-from-input',
    title: 'User text compiled as a regular expression',
    merge: {
      title: 'Name filter',
      description: 'Filters widget names by what the user typed in the search box.',
    },
    changes: {
      'src/filter.ts': {
        after: `export function matchesTerm(name: string, term: string): boolean {
  return new RegExp(term, 'i').test(name)
}

export function filterNames(names: string[], term: string): string[] {
  return names.filter((name) => matchesTerm(name, term))
}
`,
      },
    },
    problems: [
      {
        id: 'term-as-regexp',
        path: 'src/filter.ts',
        find: "return new RegExp(term, 'i').test(name)",
        note: 'A term like "(" throws, and a crafted one can hang the matcher; escape it or use includes().',
        minSeverity: 'minor',
      },
    ],
  }),
]
