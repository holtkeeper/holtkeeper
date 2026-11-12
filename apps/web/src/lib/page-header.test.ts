import { describe, expect, test } from 'bun:test'

import { currentTab, moreMenuLabel } from './page-header.ts'

const tabs = [
  { to: '/', label: 'Home' },
  { to: '/widgets', label: 'Widgets' },
  { to: '/widgets/groups', label: 'Groups' },
  { to: '/gadgets/', label: 'Gadgets' },
]
const current = (pathname: string) => currentTab(tabs, pathname)?.label

describe('currentTab', () => {
  test('matches the tab at or under the pathname, longest first', () => {
    expect(current('/widgets')).toBe('Widgets')
    expect(current('/widgets/acme:shop/web')).toBe('Widgets')
    expect(current('/widgets/groups')).toBe('Groups')
    expect(current('/widgets/groups/shapes')).toBe('Groups')
  })

  test('the root only matches itself', () => {
    expect(current('/')).toBe('Home')
    expect(current('/other')).toBeUndefined()
  })

  test('trailing slashes and partial segments', () => {
    expect(current('/widgets/')).toBe('Widgets')
    expect(current('/gadgets')).toBe('Gadgets')
    expect(current('/widgetsmore')).toBeUndefined()
  })
})

test('moreMenuLabel lists the items', () => {
  expect(moreMenuLabel(['Export list', 'Open audits'])).toBe(
    'More actions: export list, open audits',
  )
  expect(moreMenuLabel([])).toBe('More actions')
})
