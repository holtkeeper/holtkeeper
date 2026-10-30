import { expect, test } from 'bun:test'

import { enginesOf } from './engine.ts'

test('engines from dependencies', () => {
  expect(enginesOf({ dependencies: { 'pixi.js': '^8', react: '^19' } })).toEqual(['pixi'])
  expect(enginesOf({ devDependencies: { '@babylonjs/core': '^7', three: '^0.170' } })).toEqual([
    'three',
    'babylon',
  ])
  expect(enginesOf({ creator: { version: '3.8' } })).toEqual(['cocos'])
  expect(enginesOf({ dependencies: { phaser: '^3' } })).toEqual(['phaser'])
  expect(enginesOf(null)).toEqual([])
})
