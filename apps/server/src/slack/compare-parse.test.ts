import { describe, expect, test } from 'bun:test'

import { resolveEnvironment, resolveRepoName, stripMentions } from './compare-parse.ts'

const candidates = [
  { repo: { forge: 'work', path: 'shapes/widget-service' }, environments: ['cert', 'prod'] },
  { repo: { forge: 'work', path: 'shapes/Gadget_Check' }, environments: ['cert', 'prod'] },
  { repo: { forge: 'work', path: 'toys/kite' }, environments: ['stage'] },
  { repo: { forge: 'other', path: 'toys/kite' }, environments: ['stage'] },
]

describe('resolveRepoName', () => {
  test('matches keys and paths in any case', () => {
    expect(resolveRepoName('WORK:shapes/Widget-Service', candidates)?.path).toBe(
      'shapes/widget-service',
    )
    expect(resolveRepoName('shapes/gadget_check', candidates)?.path).toBe('shapes/Gadget_Check')
  })

  test('matches a last segment or a loose spelling only when one repository fits', () => {
    expect(resolveRepoName('widget service', candidates)?.path).toBe('shapes/widget-service')
    expect(resolveRepoName('gadget-check', candidates)?.path).toBe('shapes/Gadget_Check')
    expect(resolveRepoName('kite', candidates)).toBeUndefined()
    expect(resolveRepoName('other:toys/kite', candidates)?.forge).toBe('other')
    expect(resolveRepoName('moon base', candidates)).toBeUndefined()
  })
})

describe('resolveEnvironment', () => {
  test('exact, alias and prefix', () => {
    expect(resolveEnvironment('PROD', ['cert', 'prod'])).toBe('prod')
    expect(resolveEnvironment('production', ['certification', 'prod'])).toBe('prod')
    expect(resolveEnvironment('cert', ['certification', 'production'])).toBe('certification')
    expect(resolveEnvironment('stag', ['staging', 'production'])).toBe('staging')
    expect(resolveEnvironment('qa', ['cert', 'prod'])).toBeUndefined()
    expect(resolveEnvironment('p', ['prod', 'preprod'])).toBeUndefined()
  })
})

describe('stripMentions', () => {
  test('removes user and channel mentions', () => {
    expect(stripMentions('<@U0BOT>  hi <!here> there')).toBe('hi there')
  })
})
