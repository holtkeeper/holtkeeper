import { describe, expect, test } from 'bun:test'

import {
  chunkId,
  chunkMarkdown,
  documentChunks,
  headingMajors,
  headingVersion,
  slug,
} from './markdown.ts'

const ref = { ecosystem: 'npm', name: 'lib' } as const

describe('chunkMarkdown', () => {
  test('splits by heading and keeps the heading path', () => {
    const chunks = chunkMarkdown(
      '# Lib\n\nIntro.\n\n## Install\n\nnpm i lib\n\n### Yarn\n\nyarn add lib\n\n## Empty\n\n## API\n\nCall it.',
    )
    expect(chunks.map((chunk) => [chunk.headings, chunk.anchor])).toEqual([
      [['Lib'], 'lib'],
      [['Lib', 'Install'], 'install'],
      [['Lib', 'Install', 'Yarn'], 'yarn'],
      [['Lib', 'API'], 'api'],
    ])
    expect(chunks[1]?.text).toBe('## Install\n\nnpm i lib')
  })

  test('keeps text before the first heading and ignores headings in fences', () => {
    const chunks = chunkMarkdown('Preface\n\n```sh\n# not a heading\n```\n\n# Title\n\nBody')
    expect(chunks[0]).toEqual({ headings: [], text: 'Preface\n\n```sh\n# not a heading\n```' })
    expect(chunks[1]?.headings).toEqual(['Title'])
  })

  test('long sections are split between paragraphs, not inside fences', () => {
    const paragraph = 'word '.repeat(60).trim()
    const fence = `\`\`\`ts\n${'const x = 1\n'.repeat(20)}\`\`\``
    const text = `## Long\n\n${paragraph}\n\n${fence}\n\n${paragraph}\n\n${paragraph}`
    const chunks = chunkMarkdown(text, 400)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(400)
      expect(chunk.headings).toEqual(['Long'])
      expect((chunk.text.match(/```/g) ?? []).length % 2).toBe(0)
    }
    expect(chunks.map((chunk) => chunk.text).join('\n\n')).toBe(text)
  })

  test('duplicate headings get numbered anchors', () => {
    const chunks = chunkMarkdown('## Example\n\na\n\n## Example\n\nb')
    expect(chunks.map((chunk) => chunk.anchor)).toEqual(['example', 'example-1'])
  })
})

test('slug follows GitHub', () => {
  expect(slug('`useState()` & Hooks!')).toBe('usestate--hooks')
  expect(slug('[v2.0.0](https://x) — 2024')).toBe('v200--2024')
})

test('heading versions and majors', () => {
  expect(headingVersion('[2.1.0] - 2024-05-01')).toBe('2.1.0')
  expect(headingVersion('v3.0.0-rc.1')).toBe('3.0.0-rc.1')
  expect(headingVersion('lib@1.2.3')).toBe('1.2.3')
  expect(headingVersion('Unreleased')).toBeUndefined()
  expect(headingMajors('Migrating from v3 to v4')).toEqual([3, 4])
})

test('chunk ids are stable and documentChunks drops duplicates', () => {
  expect(chunkId(ref, 'archive', 'README.md', ['A'], 'x')).toBe(
    chunkId(ref, 'archive', 'README.md', ['A'], 'x'),
  )
  expect(chunkId(ref, 'archive', 'README.md', ['A'], 'x')).not.toBe(
    chunkId(ref, 'repository', 'README.md', ['A'], 'x'),
  )
  const chunks = documentChunks(ref, 'archive', 'README.md', '# A\n\nx\n\n# A\n\nx', {
    url: 'https://u/README.md',
  })
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.url).toBe('https://u/README.md#a')
})
