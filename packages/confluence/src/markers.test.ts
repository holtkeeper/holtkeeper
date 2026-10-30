import { describe, expect, test } from 'bun:test'

import { ConfluenceInputError, MarkerError } from './errors.ts'
import { findSection, normalizeStorage, renderMarker, replaceSectionInStorage } from './markers.ts'

const start = renderMarker('deps', 'start')
const end = renderMarker('deps', 'end')

describe('replaceSectionInStorage', () => {
  test('replaces only the content between markers', () => {
    const body = `<p>before</p>${start}<p>old</p>${end}<p>after</p>`
    const update = replaceSectionInStorage(body, 'deps', '<p>new</p>')
    expect(update).toEqual({
      body: `<p>before</p>${start}<p>new</p>${end}<p>after</p>`,
      changed: true,
      appended: false,
    })
  })

  test('keeps markers as the editor rewrote them', () => {
    const edited =
      '<p>x</p><p local-id="a1"><ac:structured-macro ac:name="anchor" ac:schema-version="1" ac:macro-id="m-1">' +
      '<ac:parameter ac:name="">holtkeeper:deps:start</ac:parameter></ac:structured-macro></p>\n<p>old</p>\n' +
      '<p local-id="a2"> <ac:structured-macro ac:macro-id="m-2" ac:name="anchor"><ac:parameter ac:name=""> holtkeeper:deps:end </ac:parameter></ac:structured-macro></p><p>y</p>'
    const update = replaceSectionInStorage(edited, 'deps', '<p>new</p>')
    expect(update.body).toBe(edited.replace('\n<p>old</p>\n', '<p>new</p>'))
  })

  test('appends a section when markers are missing', () => {
    expect(replaceSectionInStorage('<p>page</p>', 'deps', '<p>c</p>')).toEqual({
      body: `<p>page</p>${start}<p>c</p>${end}`,
      changed: true,
      appended: true,
    })
  })

  test('reports unchanged content modulo whitespace and editor ids', () => {
    const body = `${start}\n  <p local-id="z">a   b</p>\n<br/>${end}`
    expect(replaceSectionInStorage(body, 'deps', '<p>a b</p><br />').changed).toBe(false)
  })

  test('other sections are independent', () => {
    const other = `${renderMarker('other', 'start')}<p>o</p>${renderMarker('other', 'end')}`
    const update = replaceSectionInStorage(other, 'deps', '<p>d</p>')
    expect(update.body.startsWith(other)).toBe(true)
    expect(findSection(update.body, 'other')).toBeDefined()
  })

  test('rejects broken marker layouts', () => {
    expect(() => replaceSectionInStorage(`${start}<p>a</p>`, 'deps', '')).toThrow(MarkerError)
    expect(() => replaceSectionInStorage(`${end}${start}`, 'deps', '')).toThrow(MarkerError)
    expect(() => replaceSectionInStorage(`${start}${end}${start}${end}`, 'deps', '')).toThrow(
      MarkerError,
    )
    const inCell = `<table><tr><td>${start}</td></tr></table>${end}`
    expect(() => replaceSectionInStorage(inCell, 'deps', '')).toThrow(MarkerError)
  })

  test('rejects bad ids and content', () => {
    expect(() => replaceSectionInStorage('', 'a b', '')).toThrow(ConfluenceInputError)
    expect(() => replaceSectionInStorage('', 'deps', '<p>')).toThrow(ConfluenceInputError)
    expect(() => replaceSectionInStorage('', 'deps', start)).toThrow(ConfluenceInputError)
  })
})

test('an empty marker id replaces the whole body', () => {
  expect(replaceSectionInStorage('<p>a</p>', '', '<p>b</p>')).toEqual({
    body: '<p>b</p>',
    changed: true,
    appended: false,
  })
  expect(replaceSectionInStorage('<p>a</p>', '', ' <p>a</p>\n').changed).toBe(false)
})

test('ids may carry the holtkeeper prefix without doubling it', () => {
  expect(
    replaceSectionInStorage(`${start}<p>a</p>${end}`, 'holtkeeper:deps', '<p>a</p>').changed,
  ).toBe(false)
})

describe('normalizeStorage', () => {
  test('treats nbsp forms and self-closing spacing alike', () => {
    expect(normalizeStorage('<p>a&nbsp;b<br /></p>')).toBe(normalizeStorage('<p>a&#160;b<br/></p>'))
  })
})
