import { describe, expect, test } from 'bun:test'

import { withoutFolderTwins } from './packages.ts'

describe('withoutFolderTwins', () => {
  test('drops a folder mapping that repeats an entry point of the same name', () => {
    const entries = [
      { subpath: '.' },
      { subpath: './services' },
      { subpath: './services/' },
      { subpath: './assets/' },
    ]
    expect(withoutFolderTwins(entries).map((entry) => entry.subpath)).toEqual([
      '.',
      './services',
      './assets/',
    ])
  })
})
