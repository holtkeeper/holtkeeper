import { expect, test } from 'bun:test'

import { imageType } from './image.ts'

const bytes = (...values: number[]) => new Uint8Array(values)

test('recognizes images by their signature, not by name', () => {
  expect(imageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d))).toBe('image/png')
  expect(imageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
  expect(imageType(bytes(0x47, 0x49, 0x46, 0x38, 0x39))).toBe('image/gif')
  expect(imageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
  expect(imageType(new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="x"/>'))).toBe(
    'image/svg+xml',
  )
  expect(imageType(new TextEncoder().encode('<html><svg/></html>'))).toBeUndefined()
  expect(imageType(new TextEncoder().encode('{"message":"404"}'))).toBeUndefined()
})
