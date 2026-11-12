import { describe, expect, test } from 'bun:test'

import { avatarFileProblem, versionedAvatarUrl } from './bot-account.ts'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])

describe('avatarFileProblem', () => {
  test('accepts a small image whose contents match its name', async () => {
    expect(await avatarFileProblem(new File([png], 'face.png'))).toBeUndefined()
  })

  test('rejects large files, other types and disguised files', async () => {
    const big = new Uint8Array(200 * 1024 + 1)
    big.set(png)
    expect(await avatarFileProblem(new File([big], 'face.png'))).toContain('larger than 200 KB')
    expect(await avatarFileProblem(new File(['<svg/>'], 'face.svg'))).toContain('.png')
    expect(await avatarFileProblem(new File([png], 'face.gif'))).toContain('not the image')
  })
})

describe('versionedAvatarUrl', () => {
  test('adds the upload version and keeps other parameters', () => {
    expect(versionedAvatarUrl('https://forge.test/a.png?width=96', 3)).toBe(
      'https://forge.test/a.png?width=96&v=3',
    )
    expect(versionedAvatarUrl('https://forge.test/a.png', 0)).toBe('https://forge.test/a.png')
    expect(versionedAvatarUrl(undefined, 2)).toBe('')
  })
})
