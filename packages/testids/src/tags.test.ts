import { describe, expect, test } from 'bun:test'

import { blankBlocks, onlyTemplate, scanTags } from './tags.ts'

const names = (text: string, syntax: 'jsx' | 'html' = 'jsx') =>
  scanTags(text, syntax).map((tag) => tag.name)

describe('jsx', () => {
  test('reads tags, attributes, lines and spreads', () => {
    const tags = scanTags(
      `export function Form(props) {
  return (
    <form onSubmit={() => submit(a > b)}>
      <S.Input data-testid="name" value={name} {...props} />
      <button type="submit" disabled>Save</button>
    </form>
  )
}`,
      'jsx',
    )
    expect(tags.map((tag) => [tag.name, tag.line])).toEqual([
      ['form', 3],
      ['S.Input', 4],
      ['button', 5],
    ])
    expect(tags[1]?.attributes).toEqual([
      { name: 'data-testid', value: 'name' },
      { name: 'value', expression: 'name' },
    ])
    expect(tags[1]?.spread).toBe(true)
    expect(tags[2]?.attributes).toEqual([{ name: 'type', value: 'submit' }, { name: 'disabled' }])
  })

  test('skips comparisons, type arguments and comments', () => {
    expect(
      names(`const [v, setV] = useState<string>('')
if (a<b && c < d) foo()
const map: Record<string, Item> = {}
// <button>commented</button>
/* <a href="x">old</a> */
const x = cond ? <a href="/">home</a> : null`),
    ).toEqual(['a'])
  })

  test('finds tags inside attribute expressions and after return', () => {
    expect(
      names(
        `function A() { return <List renderItem={(item) => <Row onClick={go}>{item}</Row>} /> }`,
      ),
    ).toEqual(['List', 'Row'])
  })

  test('reads lit templates', () => {
    expect(scanTags('html`<button @click=${this.go}>Go</button>`', 'jsx')[0]?.attributes).toEqual([
      { name: '@click', expression: 'this.go' },
    ])
  })
})

describe('html', () => {
  test('reads Vue, Svelte and Angular binding syntax', () => {
    const [tag] = scanTags(
      `<el-button :data-testid="id" @click.prevent="go" v-bind="$attrs" (click)="x()" on:click={go}>`,
      'html',
    )
    expect(tag?.name).toBe('el-button')
    expect(tag?.attributes.map((a) => a.name)).toEqual([
      ':data-testid',
      '@click.prevent',
      'v-bind',
      '(click)',
      'on:click',
    ])
  })

  test('skips comments and closing tags', () => {
    expect(names('<!-- <button> --><div></div><a href="#">x</a>', 'html')).toEqual(['div', 'a'])
  })
})

test('onlyTemplate keeps the outer template and its lines', () => {
  const text =
    '<script setup>\nconst a = 1 < 2\n</script>\n<template>\n  <button>x</button>\n</template>\n'
  const [tag] = scanTags(onlyTemplate(text), 'html')
  expect(tag).toMatchObject({ name: 'button', line: 5 })
})

test('blankBlocks removes script and style bodies', () => {
  expect(names(blankBlocks('<script>if (a<b) {}</script>\n<button/>', ['script']), 'html')).toEqual(
    ['button'],
  )
})
