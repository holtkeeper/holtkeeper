import { expect, test } from 'bun:test'

import { isEditableElement, isEditableTarget, isSlashFocus } from './slash-focus.ts'

test('focuses on a plain slash', () => {
  expect(isSlashFocus({ key: '/' })).toBe(true)
  expect(isSlashFocus({ key: '?' })).toBe(false)
})

test('leaves the slash alone while typing, with a modifier or once handled', () => {
  expect(isSlashFocus({ key: '/', editable: true })).toBe(false)
  expect(isSlashFocus({ key: '/', metaKey: true })).toBe(false)
  expect(isSlashFocus({ key: '/', ctrlKey: true })).toBe(false)
  expect(isSlashFocus({ key: '/', altKey: true })).toBe(false)
  expect(isSlashFocus({ key: '/', defaultPrevented: true })).toBe(false)
})

test('treats text fields, selects and contenteditable as editable', () => {
  expect(isEditableElement({ tagName: 'INPUT' })).toBe(true)
  expect(isEditableElement({ tagName: 'input', type: 'search' })).toBe(true)
  expect(isEditableElement({ tagName: 'TEXTAREA' })).toBe(true)
  expect(isEditableElement({ tagName: 'SELECT' })).toBe(true)
  expect(isEditableElement({ tagName: 'DIV', isContentEditable: true })).toBe(true)
})

test('does not treat buttons, checkboxes or plain elements as editable', () => {
  expect(isEditableElement({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
  expect(isEditableElement({ tagName: 'INPUT', type: 'button' })).toBe(false)
  expect(isEditableElement({ tagName: 'BUTTON' })).toBe(false)
  expect(isEditableElement({ tagName: 'DIV' })).toBe(false)
})

test('reads editability from an event target', () => {
  expect(isEditableTarget({ tagName: 'INPUT', type: 'text' } as unknown as EventTarget)).toBe(true)
  expect(isEditableTarget({ tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget)).toBe(
    false,
  )
  expect(isEditableTarget(null)).toBe(false)
})
