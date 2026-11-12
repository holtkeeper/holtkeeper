import { describe, expect, test } from 'bun:test'

import { ACCOUNT_AVATAR_MAX_BYTES, checkAccountAvatar } from './avatar.ts'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
const tiff = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a])
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')

describe('checkAccountAvatar', () => {
  test('accepts images whose contents match the extension', () => {
    expect(checkAccountAvatar({ filename: 'Face.PNG', size: 8, head: png })).toEqual({
      contentType: 'image/png',
    })
    expect(checkAccountAvatar({ filename: 'a.webp', size: 12, head: webp })).toEqual({
      contentType: 'image/webp',
    })
    expect(checkAccountAvatar({ filename: 'a.tiff', size: 4, head: tiff })).toEqual({
      contentType: 'image/tiff',
    })
  })

  test('rejects empty and too large files', () => {
    expect(checkAccountAvatar({ filename: 'a.png', size: 0, head: png })).toEqual({
      problem: 'The image is empty.',
    })
    expect(
      checkAccountAvatar({ filename: 'a.png', size: ACCOUNT_AVATAR_MAX_BYTES + 1, head: png }),
    ).toEqual({ problem: 'The image is larger than 200 KB.' })
  })

  test('rejects other extensions and contents that do not match', () => {
    expect(checkAccountAvatar({ filename: 'a.svg', size: svg.length, head: svg })).toMatchObject({
      problem: expect.stringContaining('.png'),
    })
    expect(checkAccountAvatar({ filename: 'noext', size: 8, head: png })).toHaveProperty('problem')
    expect(checkAccountAvatar({ filename: 'a.jpg', size: 8, head: png })).toMatchObject({
      problem: expect.stringContaining('not the image its name says'),
    })
  })
})
