import { defineCase } from './build.ts'

/** Cases with a security hole, a slow loop or a missed test. */
export const securityCases = [
  defineCase({
    id: 'sql-concat',
    title: 'Query built by string concatenation',
    merge: {
      title: 'Find widgets by name',
      description: 'Adds a lookup of widgets by the name in the query string.',
    },
    files: {
      'src/db.ts': `export interface Db {
  query(sql: string, params?: unknown[]): Promise<unknown[]>
}
`,
    },
    changes: {
      'src/widgets.ts': {
        after: `import type { Db } from './db.ts'

export async function findByName(db: Db, name: string) {
  return db.query(\`SELECT * FROM widgets WHERE name = '\${name}'\`)
}
`,
      },
    },
    problems: [
      {
        id: 'injection',
        path: 'src/widgets.ts',
        find: "return db.query(`SELECT * FROM widgets WHERE name = '${name}'`)",
        note: 'User input is interpolated into SQL; pass it as a parameter.',
        categories: ['security', 'bug'],
        minSeverity: 'critical',
      },
    ],
  }),

  defineCase({
    id: 'path-traversal',
    title: 'File name from the request joined to a directory unchecked',
    merge: {
      title: 'Download uploads',
      description: 'Serves a file from the uploads directory by name.',
    },
    changes: {
      'src/download.ts': {
        after: `import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const UPLOAD_DIR = '/srv/uploads'

export async function download(name: string): Promise<Uint8Array> {
  return readFile(join(UPLOAD_DIR, name))
}
`,
      },
    },
    problems: [
      {
        id: 'traversal',
        path: 'src/download.ts',
        find: 'return readFile(join(UPLOAD_DIR, name))',
        note: 'A name like ../../etc/passwd leaves the uploads directory.',
        categories: ['security', 'bug'],
        minSeverity: 'critical',
      },
    ],
  }),

  defineCase({
    id: 'hardcoded-token',
    title: 'Live API token committed in source',
    merge: {
      title: 'Call the shipping API',
      description: 'Fetches shipping rates from the carrier.',
    },
    changes: {
      'src/shipping.ts': {
        after: `const API_TOKEN = 'wk_live_9f2c7a1d4b6e8035c1d2'

export async function rates(parcelId: string): Promise<unknown> {
  const response = await fetch(\`https://carrier.example/rates/\${parcelId}\`, {
    headers: { authorization: \`Bearer \${API_TOKEN}\` },
  })
  return response.json()
}
`,
      },
    },
    problems: [
      {
        id: 'secret',
        path: 'src/shipping.ts',
        find: "const API_TOKEN = 'wk_live_9f2c7a1d4b6e8035c1d2'",
        note: 'A live credential in the repository; read it from the environment and rotate it.',
        categories: ['security'],
        minSeverity: 'critical',
      },
    ],
  }),

  defineCase({
    id: 'inner-html',
    title: 'User text written with innerHTML',
    merge: { title: 'Show comments', description: 'Renders the comments of a widget in a list.' },
    changes: {
      'src/comments.ts': {
        after: `export interface Comment {
  author: string
  text: string
}

export function renderComments(list: HTMLElement, comments: Comment[]): void {
  list.innerHTML = ''
  for (const comment of comments) {
    const item = document.createElement('li')
    item.innerHTML = \`<b>\${comment.author}</b>: \${comment.text}\`
    list.append(item)
  }
}
`,
      },
    },
    problems: [
      {
        id: 'xss',
        path: 'src/comments.ts',
        find: 'item.innerHTML = `<b>${comment.author}</b>: ${comment.text}`',
        note: 'Comment text and author are inserted as HTML: stored XSS.',
        categories: ['security'],
        minSeverity: 'critical',
      },
    ],
  }),

  defineCase({
    id: 'exec-interpolated',
    title: 'Shell command built from a file name',
    merge: {
      title: 'Thumbnails',
      description: 'Creates a thumbnail of an uploaded image with ImageMagick.',
    },
    changes: {
      'src/thumbnail.ts': {
        after: `import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(exec)

export async function thumbnail(file: string): Promise<void> {
  await run(\`convert \${file} -resize 64x64 \${file}.thumb.png\`)
}
`,
      },
    },
    problems: [
      {
        id: 'injection',
        path: 'src/thumbnail.ts',
        find: 'await run(`convert ${file} -resize 64x64 ${file}.thumb.png`)',
        note: 'A file name with shell metacharacters runs arbitrary commands; use execFile with an argument list.',
        categories: ['security', 'bug'],
        minSeverity: 'critical',
      },
    ],
  }),

  defineCase({
    id: 'query-in-loop',
    title: 'One query per id instead of one for all',
    merge: {
      title: 'Load widgets by id',
      description: 'Adds `loadWidgets`, which returns the widgets of a list of ids.',
    },
    files: {
      'src/db.ts': `export interface Db {
  query(sql: string, params?: unknown[]): Promise<unknown[]>
}
`,
    },
    changes: {
      'src/load.ts': {
        after: `import type { Db } from './db.ts'

export async function loadWidgets(db: Db, ids: string[]): Promise<unknown[]> {
  const widgets: unknown[] = []
  for (const id of ids) {
    const [widget] = await db.query('SELECT * FROM widgets WHERE id = $1', [id])
    widgets.push(widget)
  }
  return widgets
}
`,
      },
    },
    problems: [
      {
        id: 'n-plus-one',
        path: 'src/load.ts',
        find: "const [widget] = await db.query('SELECT * FROM widgets WHERE id = $1', [id])",
        note: 'A sequential query per id; one `WHERE id = ANY($1)` does it in a single round trip.',
        categories: ['performance', 'maintainability'],
        minSeverity: 'minor',
      },
    ],
  }),

  defineCase({
    id: 'new-logic-no-tests',
    title: 'New branching logic without a test in a repository that has tests',
    merge: {
      title: 'Shipping fee',
      description: 'Adds the shipping fee rules: free from 50, 5 up to 20 kg, else 12.',
    },
    files: {
      'src/price.ts': `export const price = (cents: number, qty: number) => cents * qty
`,
      'src/price.test.ts': `import { expect, test } from 'bun:test'

import { price } from './price.ts'

test('multiplies', () => {
  expect(price(250, 2)).toBe(500)
})
`,
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
    problems: [
      {
        id: 'no-test',
        path: 'src/fee.ts',
        find: `export function shippingFee(orderTotal: number, weightKg: number): number {
  if (orderTotal >= 50) return 0
  if (weightKg <= 20) return 5
  return 12
}`,
        note: 'Three rules and their boundaries (50, 20) without a test next to src/price.test.ts.',
        categories: ['tests'],
        minSeverity: 'minor',
      },
    ],
  }),

  defineCase({
    id: 'focused-test',
    title: 'A focused test left in the suite',
    merge: { title: 'Test the tag helper', description: 'Adds tests for `slugify`.' },
    files: {
      'src/slug.ts': `export const slugify = (text: string) => text.trim().toLowerCase().replaceAll(' ', '-')
`,
    },
    changes: {
      'src/slug.test.ts': {
        after: `import { expect, test } from 'bun:test'

import { slugify } from './slug.ts'

test('lowercases', () => {
  expect(slugify('Big Widget')).toBe('big-widget')
})

test.only('trims', () => {
  expect(slugify('  Big ')).toBe('big')
})
`,
      },
    },
    problems: [
      {
        id: 'only',
        path: 'src/slug.test.ts',
        find: "test.only('trims', () => {",
        note: 'test.only makes the runner skip every other test in the file.',
        categories: ['tests', 'bug', 'maintainability'],
        minSeverity: 'minor',
      },
    ],
  }),

  defineCase({
    id: 'order-service-several',
    title: 'Several problems in one file',
    merge: {
      title: 'Order history',
      description:
        'Lists the last 10 orders of a customer, newest first, and stores a note on an order.',
    },
    files: {
      'src/db.ts': `export interface Db {
  query(sql: string, params?: unknown[]): Promise<unknown[]>
  execute(sql: string, params?: unknown[]): Promise<void>
}
`,
    },
    changes: {
      'src/orders.ts': {
        after: `import type { Db } from './db.ts'

export async function lastOrders(db: Db, customer: string): Promise<unknown[]> {
  const rows = await db.query(\`SELECT * FROM orders WHERE customer = '\${customer}' ORDER BY created DESC\`)
  return rows.slice(0, 9)
}

export async function addNote(db: Db, orderId: number, note: string): Promise<void> {
  db.execute('UPDATE orders SET note = $1 WHERE id = $2', [note, orderId])
}
`,
      },
    },
    problems: [
      {
        id: 'injection',
        path: 'src/orders.ts',
        find: "const rows = await db.query(`SELECT * FROM orders WHERE customer = '${customer}' ORDER BY created DESC`)",
        note: 'Customer is interpolated into SQL.',
        categories: ['security', 'bug'],
        minSeverity: 'critical',
      },
      {
        id: 'nine-not-ten',
        path: 'src/orders.ts',
        find: 'return rows.slice(0, 9)',
        note: 'Returns 9 orders, the description asks for 10.',
        minSeverity: 'minor',
      },
      {
        id: 'not-awaited',
        path: 'src/orders.ts',
        find: "db.execute('UPDATE orders SET note = $1 WHERE id = $2', [note, orderId])",
        note: 'The promise is dropped: callers continue before the write and never see its failure.',
        minSeverity: 'major',
      },
    ],
  }),
]
