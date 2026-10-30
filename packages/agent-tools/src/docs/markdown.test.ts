import { describe, expect, test } from 'bun:test'

import { headingVersion, releases, releasesBetween, sections } from './markdown.ts'

const changelog = `# Changelog
## Unreleased
## [2.0.0] - 2024-01-01
### Fixed in 1.9.9
- x
## v1.10.0
\`\`\`
## 9.9.9 inside a fence
\`\`\`
## 1.2.0-beta.1
`

describe('markdown', () => {
  test('reads versions from headings', () => {
    expect(headingVersion('[2.0.0] - 2024-01-01')).toBe('2.0.0')
    expect(headingVersion('v1.10.0')).toBe('1.10.0')
    expect(headingVersion('pkg@3.1.0')).toBe('3.1.0')
    expect(headingVersion('1.2.0-beta.1')).toBe('1.2.0-beta.1')
    expect(headingVersion('Unreleased')).toBeUndefined()
  })

  test('sections nest and skip fenced code', () => {
    const all = sections(changelog)
    expect(all.map((section) => section.title)).not.toContain('9.9.9 inside a fence')
    const two = all.find((section) => section.version === '2.0.0')
    expect(two?.lines).toEqual(['## [2.0.0] - 2024-01-01', '### Fixed in 1.9.9', '- x'])
  })

  test('releases use the dominant level and filter by range', () => {
    const list = releases(changelog)
    expect(list.map((section) => section.version)).toEqual(['2.0.0', '1.10.0', '1.2.0-beta.1'])
    expect(releasesBetween(list, '1.2.0', '2.0.0').map((section) => section.version)).toEqual([
      '2.0.0',
      '1.10.0',
    ])
    expect(releasesBetween(list, undefined, '1.9.0').map((section) => section.version)).toEqual([
      '1.2.0-beta.1',
    ])
  })
})
