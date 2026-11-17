import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { impactSection } from './impact.ts'
import type { FileScope } from './scope.ts'

const WIDGET = `export class Widget {
  pending = false
  private count = 0

  send(): void {
    if (this.pending) return
    this.pending = true
    this.count++
  }

  flush(): void {
    if (this.pending) this.deliver()
  }

  deliver(): void {
    this.count += 1
  }
}

export function makeWidget(): Widget {
  return new Widget()
}
`

const FILES: Record<string, string> = {
  'src/Widget.ts': WIDGET,
  'src/panel.ts': `import { Widget, makeWidget } from './Widget.ts'

export function openPanel(widget: Widget): void {
  widget.send()
  widget.flush()
  const other = makeWidget()
  other.pending = false
}
`,
  'src/__tests__/Widget.test.ts': `import { Widget } from '../Widget.ts'

test('send', () => {
  const widget = new Widget()
  widget.send()
  expect(widget.pending).toBe(true)
})
`,
  'src/Gadget.ts': `export const gadgetName = 'gadget'\n`,
  'src/Gadget.spec.ts': `test('name', () => {})\n`,
  'src/notes.md': '# Widget\nsend pending\n',
}

let dir: string

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([path, text]) => {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), text)
    }),
  )
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'review-impact-'))
  await writeTree(dir, FILES)
})

afterAll(() => rm(dir, { recursive: true, force: true }))

const scope = (path: string, lines: number[]): FileScope => ({
  path,
  oldPath: path,
  status: 'modified',
  hunks: [],
  lines: new Set(lines),
  visible: new Map(),
})

describe('impactSection', () => {
  test('lists writers and readers of a changed field, its callers and tests', async () => {
    const section = await impactSection({ dir, files: [scope('src/Widget.ts', [2, 7])] })
    expect(section).toStartWith('## Impact of the changed code (computed)')
    expect(section).toContain('### src/Widget.ts › Widget.pending (field)')
    const pending = section
      .split('### ')
      .find((part) => part.startsWith('src/Widget.ts › Widget.pending'))
    expect(pending).toContain(
      'Writes (2):\n- src/Widget.ts:7: this.pending = true\n- src/panel.ts:7: other.pending = false',
    )
    expect(pending).toContain(
      'Reads (2):\n- src/Widget.ts:6: if (this.pending) return\n- src/Widget.ts:12: if (this.pending) this.deliver()',
    )
    expect(pending).toContain(
      'In tests (1):\n- src/__tests__/Widget.test.ts:6: expect(widget.pending).toBe(true)',
    )
    expect(section).toContain('### src/Widget.ts › Widget.send (method)')
    expect(section).toContain('- src/panel.ts:4: widget.send()')
    expect(section).toContain('src/__tests__/Widget.test.ts (imports it)')
  })

  test('does not list unchanged declarations', async () => {
    const section = await impactSection({ dir, files: [scope('src/Widget.ts', [16])] })
    expect(section).toContain('Widget.deliver (method)')
    expect(section).toContain('- src/Widget.ts:12: if (this.pending) this.deliver()')
    expect(section).not.toContain('Widget.pending')
    expect(section).not.toContain('Widget.send')
    expect(section).not.toContain('makeWidget')
  })

  test('lists functions with callers and finds tests named after a file', async () => {
    const section = await impactSection({
      dir,
      files: [scope('src/Widget.ts', [21]), scope('src/Gadget.ts', [1])],
    })
    expect(section).toContain('### src/Widget.ts › makeWidget (function)')
    expect(section).toContain('- src/panel.ts:6: const other = makeWidget()')
    expect(section).toContain('### src/Gadget.ts › gadgetName (const)')
    expect(section).toContain('No references outside the declaration.')
    expect(section).toContain('- src/Gadget.ts: src/Gadget.spec.ts (named after it)')
  })

  test('skips short names', async () => {
    const files = { ...FILES, 'src/Widget.ts': WIDGET.replace('pending', 'on') }
    const local = await mkdtemp(join(tmpdir(), 'review-impact-'))
    await writeTree(local, files)
    const section = await impactSection({ dir: local, files: [scope('src/Widget.ts', [2])] })
    await rm(local, { recursive: true, force: true })
    expect(section).toContain('Widget.on (field)')
    expect(section).toContain('Skipped: name shorter than 4 characters')
  })

  test('skips names with too many references', async () => {
    const local = await mkdtemp(join(tmpdir(), 'review-impact-'))
    const uses = Array.from({ length: 61 }, (_, i) => `  box.label = 'x${i}'`).join('\n')
    await writeTree(local, {
      'src/Box.ts': 'export class Box {\n  label = ""\n}\n',
      'src/fill.ts': `import type { Box } from './Box.ts'\nexport function fill(box: Box) {\n${uses}\n}\n`,
    })
    const section = await impactSection({ dir: local, files: [scope('src/Box.ts', [2])] })
    await rm(local, { recursive: true, force: true })
    expect(section).toContain('Box.label (field)')
    expect(section).toContain('Skipped: more than 60 reference lines')
  })

  test('ignores non-script files, test files and files without changed lines', async () => {
    expect(
      await impactSection({
        dir,
        files: [
          scope('src/notes.md', [1, 2]),
          scope('src/__tests__/Widget.test.ts', [4]),
          scope('src/panel.ts', []),
        ],
      }),
    ).toBe('')
  })

  test('respects the character cap', async () => {
    const all = Array.from({ length: 22 }, (_, i) => i + 1)
    const full = await impactSection({ dir, files: [scope('src/Widget.ts', all)] })
    const capped = await impactSection({ dir, files: [scope('src/Widget.ts', all)], maxChars: 900 })
    expect(capped.length).toBeLessThanOrEqual(900)
    expect(capped.length).toBeLessThan(full.length)
    expect(capped).toMatch(/… \d+ more symbols not shown/)
    expect(capped).toContain('### Tests of the changed files')
  })

  test('is deterministic', async () => {
    const files = [scope('src/Widget.ts', [2, 7, 12, 21])]
    expect(await impactSection({ dir, files })).toBe(await impactSection({ dir, files }))
  })

  test('rejects when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await impactSection({
      dir,
      files: [scope('src/Widget.ts', [2])],
      signal: controller.signal,
    }).then(
      () => 'resolved',
      () => 'rejected',
    )
    expect(outcome).toBe('rejected')
  })
})
