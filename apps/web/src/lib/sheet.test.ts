import { expect, test } from 'bun:test'

import { decisionCommand, sheetCommand, sheetPosition } from './sheet.ts'

test('maps J, K and Escape to sheet commands', () => {
  expect(sheetCommand({ key: 'j' })).toBe('next')
  expect(sheetCommand({ key: 'K' })).toBe('previous')
  expect(sheetCommand({ key: 'Escape' })).toBe('close')
  expect(sheetCommand({ key: 'x' })).toBeUndefined()
})

test('leaves keys alone while typing or with a modifier, except Escape', () => {
  expect(sheetCommand({ key: 'j', editable: true })).toBeUndefined()
  expect(sheetCommand({ key: 'k', metaKey: true })).toBeUndefined()
  expect(sheetCommand({ key: 'j', ctrlKey: true })).toBeUndefined()
  expect(sheetCommand({ key: 'Escape', editable: true })).toBe('close')
})

test('formats the position of a record', () => {
  expect(sheetPosition(2, 41)).toBe('3 of 41')
  expect(sheetPosition(0, 1200)).toBe('1 of 1,200')
})

test('maps A, R and S to decisions and keeps the sheet keys', () => {
  expect(decisionCommand({ key: 'a' })).toBe('approve')
  expect(decisionCommand({ key: 'R' })).toBe('reject')
  expect(decisionCommand({ key: 's' })).toBe('snooze')
  expect(decisionCommand({ key: 'j' })).toBe('next')
  expect(decisionCommand({ key: 'Escape', editable: true })).toBe('close')
  expect(decisionCommand({ key: 'a', editable: true })).toBeUndefined()
  expect(decisionCommand({ key: 's', metaKey: true })).toBeUndefined()
  expect(decisionCommand({ key: 'x' })).toBeUndefined()
})
