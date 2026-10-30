import { expect, test } from 'bun:test'

import { isReferenced, tokensOf } from './references.ts'

test('file names, extensionless paths and loader keys count as references', () => {
  const tokens = tokensOf(`
    import hero from './assets/hero.png'
    this.load.audio('jump', 'sfx/jump.ogg')
    background: url("../img/sky.webp");
    load('sprites/tree')
    const key = "badge"
  `)
  expect(isReferenced('public/assets/hero.png', tokens)).toBe(true)
  expect(isReferenced('public/sfx/jump.ogg', tokens)).toBe(true)
  expect(isReferenced('static/img/sky.webp', tokens)).toBe(true)
  expect(isReferenced('public/sprites/tree.png', tokens)).toBe(true)
  expect(isReferenced('public/badge.png', tokens)).toBe(true)
  expect(isReferenced('public/favicon.ico', tokens)).toBe(true)
  expect(isReferenced('public/orphan.png', tokens)).toBe(false)
  expect(isReferenced('public/ok.png', tokensOf('ok'))).toBe(false)
})
