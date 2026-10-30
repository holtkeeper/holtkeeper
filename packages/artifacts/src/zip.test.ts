import { expect, test } from 'bun:test'

import { unzipArtifacts, zipArtifacts } from './zip.ts'

test('zips entries and refuses unsafe or duplicate paths', () => {
  const zip = zipArtifacts([
    { path: 'img/hero.webp', data: new Uint8Array([1, 2, 3]) },
    { path: 'README.md', data: '# Snippet\n' },
  ])
  const files = unzipArtifacts(zip)
  expect([...(files['img/hero.webp'] ?? [])]).toEqual([1, 2, 3])
  expect(new TextDecoder().decode(files['README.md'])).toBe('# Snippet\n')
  expect(() => zipArtifacts([{ path: '../x', data: '' }])).toThrow('unsafe')
  expect(() => zipArtifacts([{ path: '/etc/x', data: '' }])).toThrow('unsafe')
  expect(() =>
    zipArtifacts([
      { path: 'a', data: '' },
      { path: './a', data: '' },
    ]),
  ).toThrow('duplicate')
})
