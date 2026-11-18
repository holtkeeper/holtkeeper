import { describe, expect, test } from 'bun:test'

import { globList, parseFrontmatter } from './frontmatter.ts'

describe('parseFrontmatter', () => {
  test('reads scalars, inline lists and dash lists', () => {
    const parsed = parseFrontmatter(
      `---\ndescription: "Widget forms"\nalwaysApply: false\nglobs: [src/**/*.ts, 'lib/*.ts']\npaths:\n  - api/**\n  - "web/**"\n---\n\n# Body\n- rule\n`,
    )
    expect(parsed.data).toEqual({
      description: 'Widget forms',
      alwaysApply: false,
      globs: ['src/**/*.ts', 'lib/*.ts'],
      paths: ['api/**', 'web/**'],
    })
    expect(parsed.body).toBe('# Body\n- rule')
  })

  test('returns text without frontmatter as the body', () => {
    expect(parseFrontmatter('# Title\n---\ntext')).toEqual({ data: {}, body: '# Title\n---\ntext' })
  })
})

describe('globList', () => {
  test('splits strings at commas and keeps lists', () => {
    expect(globList('src/**/*.ts, test/**')).toEqual(['src/**/*.ts', 'test/**'])
    expect(globList(['a/**'])).toEqual(['a/**'])
    expect(globList(true)).toEqual([])
    expect(globList(undefined)).toEqual([])
  })
})
