import { expect, test } from 'bun:test'

import {
  defaultAttributes,
  defaultEvents,
  defaultMarkers,
  defaultRoles,
  defaultTags,
} from './analyze.ts'
import { bareName, createClassifier, eventOf } from './classify.ts'
import { scanTags } from './tags.ts'

const classify = createClassifier({
  attributes: defaultAttributes,
  tags: defaultTags,
  events: defaultEvents,
  roles: defaultRoles,
  markers: defaultMarkers,
  ignore: ['Trans'],
})

const one = (text: string, native?: string, syntax: 'jsx' | 'html' = 'jsx') => {
  const [tag] = scanTags(text, syntax)
  if (!tag) throw new Error('no tag')
  return classify(tag, native)
}

test('names events and bare attributes across syntaxes', () => {
  expect(
    ['onClick', '@click.stop', 'v-on:click', 'on:click', '(click)', 'onclick'].map(eventOf),
  ).toEqual(['click', 'click', 'click', 'click', 'click', 'click'])
  expect(eventOf('onClose')).toBe('close')
  expect(eventOf('title')).toBeUndefined()
  expect([':data-testid', 'v-bind:data-qa', '[attr.data-cy]', 'testID'].map(bareName)).toEqual([
    'data-testid',
    'data-qa',
    'data-cy',
    'testID',
  ])
})

test('native interactive tags and handlers', () => {
  expect(one('<button>x</button>', 'button')).toEqual({ status: 'missing', reason: 'button' })
  expect(one('<input type="hidden" />', 'input')).toBeUndefined()
  expect(one('<div className="x" />', 'div')).toBeUndefined()
  expect(one('<div onClick={go} />', 'div')).toEqual({ status: 'missing', reason: 'click handler' })
  expect(one('<div role="tab" />', 'div')).toEqual({ status: 'missing', reason: 'role=tab' })
  expect(one('<span tabIndex={0} />', 'span')).toEqual({ status: 'missing', reason: 'tabindex' })
})

test('components it cannot resolve count by handlers and markers', () => {
  expect(one('<Modal onClose={close} />')).toBeUndefined()
  expect(one('<Card onClick={open} />')).toEqual({ status: 'missing', reason: 'click handler' })
  expect(one('<Link to="/home" />')).toEqual({ status: 'missing', reason: 'to' })
  expect(one('<Trans onClick={x} />')).toBeUndefined()
})

test('test ids, case-insensitively, in any binding syntax; spreads are unverified', () => {
  expect(one('<button data-testid="save" />', 'button')).toMatchObject({
    status: 'tagged',
    attribute: 'data-testid',
  })
  expect(one('<Btn testID="go" onPress={go} />')).toMatchObject({ attribute: 'testID' })
  expect(one('<el-button :data-qa="id" @click="go">', undefined, 'html')).toMatchObject({
    status: 'tagged',
    attribute: 'data-qa',
  })
  expect(one('<button {...props} />', 'button')?.status).toBe('unverified')
  expect(one('<button v-bind="$attrs">', 'button', 'html')?.status).toBe('unverified')
})
