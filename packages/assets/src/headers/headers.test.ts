import { describe, expect, test } from 'bun:test'

import * as make from '../../test/fixtures.ts'
import { glbJson, parseFnt, parseJsonAtlas, parseTextAtlas } from './atlas.ts'
import { parseFlac, parseM4a, parseMp3, parseMp4Video, parseOgg, parseWav } from './audio.ts'
import { parseFont } from './font.ts'
import {
  parseAvif,
  parseBmp,
  parseGif,
  parseIco,
  parseJpeg,
  parsePng,
  parseSvg,
  parseWebp,
} from './image.ts'

describe('images', () => {
  test('png: size, depth, alpha from color type or tRNS, APNG frames', () => {
    expect(parsePng(make.png(640, 480))).toEqual({
      width: 640,
      height: 480,
      alpha: false,
      bitDepth: 8,
      animated: false,
      codec: 'rgb',
    })
    expect(parsePng(make.png(16, 16, { colorType: 6 }))?.alpha).toBe(true)
    expect(parsePng(make.png(16, 16, { colorType: 3, trns: true }))?.alpha).toBe(true)
    expect(parsePng(make.png(16, 16, { frames: 12 }))).toMatchObject({ animated: true, frames: 12 })
    expect(parsePng(make.jpeg(1, 1))).toBeUndefined()
  })

  test('jpeg: size from SOF0', () => {
    expect(parseJpeg(make.jpeg(1920, 1080))).toMatchObject({
      width: 1920,
      height: 1080,
      alpha: false,
      bitDepth: 8,
    })
    expect(parseJpeg(make.png(1, 1))).toBeUndefined()
  })

  test('gif: frames and transparency', () => {
    expect(parseGif(make.gif(32, 24, 1))).toMatchObject({
      width: 32,
      height: 24,
      frames: 1,
      animated: false,
      alpha: false,
    })
    expect(parseGif(make.gif(32, 24, 3, true))).toMatchObject({
      frames: 3,
      animated: true,
      alpha: true,
    })
  })

  test('webp: lossy, lossless and extended', () => {
    expect(parseWebp(make.webpLossy(300, 200))).toMatchObject({
      width: 300,
      height: 200,
      alpha: false,
      codec: 'lossy',
    })
    expect(parseWebp(make.webpLossless(1000, 17, true))).toMatchObject({
      width: 1000,
      height: 17,
      alpha: true,
      codec: 'lossless',
    })
    expect(parseWebp(make.webpExtended(5000, 4000, 0x12, 4))).toMatchObject({
      width: 5000,
      height: 4000,
      alpha: true,
      animated: true,
      frames: 4,
    })
  })

  test('avif: ispe size, pixi depth, auxiliary alpha', () => {
    expect(parseAvif(make.avif(800, 600))).toMatchObject({
      width: 800,
      height: 600,
      alpha: false,
      bitDepth: 8,
    })
    expect(parseAvif(make.avif(64, 64, { alpha: true, depth: 10 }))).toMatchObject({
      alpha: true,
      bitDepth: 10,
    })
  })

  test('svg: width/height, falling back to viewBox', () => {
    expect(parseSvg(make.svg('width="24px" height="16"'))).toMatchObject({ width: 24, height: 16 })
    expect(parseSvg(make.svg('viewBox="0 0 100 50" width="100%"'))).toMatchObject({
      width: 100,
      height: 50,
    })
    expect(parseSvg(new TextEncoder().encode('<html/>'))).toBeUndefined()
  })

  test('bmp and ico', () => {
    expect(parseBmp(make.bmp(10, -20, 32))).toMatchObject({
      width: 10,
      height: 20,
      alpha: true,
      bitDepth: 32,
    })
    expect(parseIco(make.ico([16, 256, 32]))).toMatchObject({ width: 256, height: 256, frames: 3 })
  })
})

describe('audio and video', () => {
  test('wav: PCM duration from the data chunk', () => {
    expect(parseWav(make.wav(0.5, 22050, 1))).toEqual({
      sampleRate: 22050,
      channels: 1,
      bitrate: 352800,
      codec: 'pcm',
      durationMs: 500,
    })
  })

  test('mp3: Xing frame count, otherwise constant bitrate', () => {
    const vbr = parseMp3(make.mp3(3, 100))
    expect(vbr).toMatchObject({ sampleRate: 44100, channels: 2, codec: 'mp3' })
    expect(vbr?.durationMs).toBe(Math.round(((100 * 1152) / 44100) * 1000))
    const cbr = parseMp3(make.mp3(10))
    expect(cbr?.durationMs).toBe(Math.round((417 * 10 * 8) / 128))
    expect(cbr?.bitrate).toBeCloseTo(128000, -3)
  })

  test('ogg: vorbis and opus from the first and last page', () => {
    expect(parseOgg(make.oggVorbis(3))).toMatchObject({
      codec: 'vorbis',
      sampleRate: 44100,
      channels: 2,
      durationMs: 3000,
    })
    expect(parseOgg(make.oggOpus(2, 1))).toMatchObject({
      codec: 'opus',
      channels: 1,
      durationMs: 2000,
    })
  })

  test('flac: STREAMINFO', () => {
    expect(parseFlac(make.flac(4, 48000, 2))).toMatchObject({
      codec: 'flac',
      sampleRate: 48000,
      channels: 2,
      durationMs: 4000,
    })
  })

  test('mp4: duration and track size', () => {
    expect(parseMp4Video(make.mp4(5, 1280, 720))).toEqual({
      durationMs: 5000,
      width: 1280,
      height: 720,
    })
    expect(parseM4a(make.mp4(5, 0, 0))?.durationMs).toBe(5000)
  })
})

describe('fonts', () => {
  test('sfnt and woff glyph counts', () => {
    expect(parseFont(make.ttf(42))).toEqual({ format: 'truetype', glyphs: 42 })
    expect(parseFont(make.ttf(7, 'OTTO'))).toEqual({ format: 'opentype', glyphs: 7 })
    expect(parseFont(make.woff(300, false))).toEqual({ format: 'woff', glyphs: 300 })
    expect(parseFont(make.woff(301, true))).toEqual({ format: 'woff', glyphs: 301 })
    expect(parseFont(new TextEncoder().encode('wOF2xxxxxxxx'))).toEqual({ format: 'woff2' })
    expect(parseFont(make.png(1, 1))).toBeUndefined()
  })
})

describe('atlases', () => {
  test('TexturePacker hash and Phaser multi-atlas JSON', () => {
    expect(parseJsonAtlas({ frames: { a: {}, b: {} }, meta: { image: 'sheet.png' } })).toEqual({
      frames: 2,
      images: ['sheet.png'],
    })
    expect(
      parseJsonAtlas({
        textures: [
          { image: 'a.png', frames: [{}, {}] },
          { image: 'b.png', frames: [{}] },
        ],
      }),
    ).toEqual({ frames: 3, images: ['a.png', 'b.png'] })
    expect(parseJsonAtlas({ name: 'config' })).toBeUndefined()
  })

  test('spine atlas and bitmap font text', () => {
    const atlas =
      '\nhero.png\nsize: 512,512\nformat: RGBA8888\nhead\n  xy: 2, 2\nbody\n  xy: 4, 4\n'
    expect(parseTextAtlas(atlas)).toEqual({ frames: 2, images: ['hero.png'] })
    const fnt = 'info face="x"\npage id=0 file="font_0.png"\nchars count=95\n'
    expect(parseFnt(fnt)).toEqual({ frames: 95, images: ['font_0.png'] })
  })

  test('glb JSON chunk', () => {
    const json = new TextEncoder().encode('{"images":[{"uri":"wood.png"}]}')
    const header = new Uint8Array(20)
    const view = new DataView(header.buffer)
    header.set([0x67, 0x6c, 0x54, 0x46])
    view.setUint32(12, json.length, true)
    header.set([0x4a, 0x53, 0x4f, 0x4e], 16)
    expect(glbJson(new Uint8Array([...header, ...json]))).toContain('wood.png')
  })
})
