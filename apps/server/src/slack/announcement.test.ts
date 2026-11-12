import { expect, test } from 'bun:test'

import {
  type AnnouncedVersion,
  SLACK_MAX_BLOCKS,
  SLACK_MAX_SECTION,
  announcementMessage,
  fitSection,
} from './announcement.ts'

const version = (overrides: Partial<AnnouncedVersion> = {}): AnnouncedVersion => ({
  title: '@acme/widgets',
  version: '2.0.0',
  previous: '1.4.0',
  compareUrl: 'https://git.acme.test/g/app/-/compare/a...b',
  sections: [{ title: 'Features', items: [{ label: 'sized widgets' }] }],
  ...overrides,
})

const texts = (blocks: readonly Record<string, unknown>[] | undefined) =>
  JSON.stringify(blocks ?? [])

test('one version gets its name and version as the header', () => {
  const message = announcementMessage({ repo: 'g/app', versions: [version()] })
  expect(message.text).toBe('@acme/widgets 2.0.0 released')
  expect(message.blocks?.[0]).toEqual({
    type: 'header',
    text: { type: 'plain_text', text: '@acme/widgets 2.0.0', emoji: false },
  })
  expect(texts(message.blocks)).toContain('since 1.4.0')
  expect(texts(message.blocks)).not.toContain('Will break on upgrade')
})

test('impact blocks list affected repositories or say none is affected', () => {
  const affected = announcementMessage({
    repo: 'g/app',
    versions: [
      version({
        impact: {
          affected: [
            {
              repo: { label: 'g/shop', url: 'https://git.acme.test/g/shop' },
              versions: ['1.4.0'],
              uses: 3,
              exports: ['Widget'],
              files: [
                { label: 'src/a.tsx:1', url: 'https://git.acme.test/a' },
                { label: 'src/b.tsx:2' },
                { label: 'src/c.tsx:3' },
                { label: 'src/d.tsx:4' },
              ],
            },
          ],
        },
      }),
    ],
  })
  const shown = texts(affected.blocks)
  expect(shown).toContain('*Will break on upgrade*')
  expect(shown).toContain(
    '<https://git.acme.test/g/shop|g/shop> (on 1.4.0): 3 broken uses of `Widget`',
  )
  expect(shown).toContain('src/c.tsx:3')
  expect(shown).not.toContain('src/d.tsx:4')

  const none = announcementMessage({
    repo: 'g/app',
    versions: [version({ impact: { affected: [] } })],
  })
  expect(texts(none.blocks)).toContain('No connected repository is affected.')
})

test('pending and unavailable impact add a line at the end', () => {
  const pending = announcementMessage({ repo: 'g/app', versions: [version()], impactPending: true })
  expect(pending.blocks?.at(-1)).toEqual({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Compatibility analysis is still running' }],
  })
  const gone = announcementMessage({
    repo: 'g/app',
    versions: [version()],
    impactUnavailable: true,
  })
  expect(texts(gone.blocks)).toContain('Compatibility analysis is unavailable')
})

test('sections stay within Slack limits and point to Holtkeeper for the rest', () => {
  const lines = Array.from({ length: 400 }, (_, index) => `• change number ${index} of widgets`)
  const text = fitSection('Changes', lines, 'https://holtkeeper.acme.test/releases')
  expect(text.length).toBeLessThanOrEqual(SLACK_MAX_SECTION)
  expect(text).toMatch(/…and \d+ more in <https:\/\/holtkeeper\.acme\.test\/releases\|Holtkeeper>$/)
  expect(fitSection('Changes', ['x'.repeat(5000)]).length).toBeLessThanOrEqual(SLACK_MAX_SECTION)

  const message = announcementMessage({
    repo: 'g/app',
    releaseUrl: 'https://holtkeeper.acme.test/releases',
    versions: [
      version({
        sections: [
          { title: 'Fixes', items: lines.map((line) => ({ label: line, url: 'https://x.test' })) },
        ],
      }),
    ],
  })
  for (const block of message.blocks ?? []) {
    const inner = (block as { text?: { text?: string } }).text?.text ?? ''
    expect(inner.length).toBeLessThanOrEqual(SLACK_MAX_SECTION)
  }
})

test('many packages stay within 50 blocks and count the rest', () => {
  const versions = Array.from({ length: 30 }, (_, index) =>
    version({
      title: `@acme/part-${index}`,
      overview: 'Parts move.',
      breaking: [{ change: 'Part lost a size' }],
      tasks: [{ label: 'ABC-123 parts' }],
      impact: { affected: [] },
    }),
  )
  const message = announcementMessage({
    repo: 'g/app',
    versions,
    impactPending: true,
    releaseUrl: 'https://holtkeeper.acme.test/releases',
  })
  expect(message.blocks!.length).toBeLessThanOrEqual(SLACK_MAX_BLOCKS)
  expect(message.text).toStartWith('New versions in g/app: @acme/part-0 2.0.0')
  expect(texts(message.blocks)).toMatch(/…and \d+ more versions in <https:/)
  expect(message.blocks?.at(-1)).toMatchObject({ type: 'context' })
})

test('AI prose is converted to mrkdwn and links survive odd URLs and cuts', () => {
  const message = announcementMessage({
    repo: 'g/app',
    versions: [
      version({
        overview: 'Widgets are **round** now, see [the guide](https://docs.acme.test/a|b).',
        breaking: [{ change: '`Gizmo` was removed', migration: 'Use **Widget**.' }],
        impact: {
          affected: [
            {
              repo: { label: 'g/shop' },
              versions: [],
              uses: 1,
              exports: ['Gizmo'],
              files: [{ label: 'src/a b.tsx:1', url: 'https://git.acme.test/x>y' }],
            },
          ],
          hidden: 2,
        },
      }),
    ],
  })
  const shown = texts(message.blocks)
  expect(shown).toContain('Widgets are *round* now, see <https://docs.acme.test/a%7Cb|the guide>.')
  expect(shown).toContain('_Use *Widget*._')
  expect(shown).toContain('<https://git.acme.test/x&gt;y|src/a b.tsx:1>')
  expect(shown).toContain('2 repositories of other teams')

  const cut = fitSection('', [`${'x'.repeat(2990)} <https://git.acme.test/long|link>`])
  expect(cut.endsWith('…')).toBe(true)
  expect(cut).not.toContain('<https')
})

test('without usage data the impact block says so instead of claiming safety', () => {
  const message = announcementMessage({
    repo: 'g/app',
    versions: [version({ impact: { affected: [], noUsageData: true } })],
  })
  expect(texts(message.blocks)).toContain('No usage data from connected repositories yet.')
  expect(texts(message.blocks)).not.toContain('No connected repository is affected.')
})
