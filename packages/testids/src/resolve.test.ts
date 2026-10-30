import { expect, test } from 'bun:test'

import { createResolver, parseModule } from './resolve.ts'

const project: Record<string, string> = {
  'src/ui/styles.ts': `import { styled } from '@linaria/react'
export const Primary = styled.button\`color: red;\`
export const Link = styled('a')\`\`
const Base = styled.div\`\`
export const Card = styled(Base)\`\`
export const Danger = styled(Primary)\`\`
`,
  'src/ui/index.ts': `export * from './styles'
export { Primary as Action } from './styles'
`,
  'src/ui/Field.tsx': `import styled from 'styled-components'
const Input = styled.input.attrs({ type: 'text' })\`\`
export default Input
`,
  'src/app/Page.tsx': `import * as S from '../ui/styles'
import { Action, Danger as Red } from '@/ui'
import Field from '../ui/Field'
import { Modal } from 'some-lib'
const Local = styled(S.Link)\`\`
`,
}

const resolver = (components: Record<string, string> = {}) =>
  createResolver({
    files: new Set(Object.keys(project)),
    read: async (file) => project[file],
    factories: ['styled', 'motion'],
    components,
    aliases: { '@/': 'src/' },
  })

test('parses styled definitions, imports and exports', () => {
  const info = parseModule(project['src/app/Page.tsx'] ?? '', ['styled'])
  expect([...info.definitions]).toEqual([['Local', 'S.Link']])
  expect(info.imports.get('S')).toEqual({ from: '../ui/styles', name: '*' })
  expect(info.imports.get('Red')).toEqual({ from: '@/ui', name: 'Danger' })
  expect(info.imports.get('Field')).toEqual({ from: '../ui/Field', name: 'default' })
})

test('follows styled components through imports, namespaces, barrels and aliases', async () => {
  const resolve = resolver()
  const page = 'src/app/Page.tsx'
  expect(await resolve('button', page)).toBe('button')
  expect(await resolve('S.Primary', page)).toBe('button')
  expect(await resolve('S.Card', page)).toBe('div')
  expect(await resolve('Action', page)).toBe('button')
  expect(await resolve('Red', page)).toBe('button')
  expect(await resolve('Field', page)).toBe('input')
  expect(await resolve('Local', page)).toBe('a')
  expect(await resolve('motion.a', page)).toBe('a')
  expect(await resolve('Modal', page)).toBeUndefined()
  expect(await resolve('el-button', page)).toBeUndefined()
})

test('configured components win, by name or pattern', async () => {
  const resolve = resolver({ Modal: 'dialog', '*Button': 'button', 'el-button': 'button' })
  expect(await resolve('Modal', 'src/app/Page.tsx')).toBe('dialog')
  expect(await resolve('IconButton', 'src/app/Page.tsx')).toBe('button')
  expect(await resolve('UI.IconButton', 'src/app/Page.tsx')).toBe('button')
  expect(await resolve('el-button', 'src/app/Page.tsx')).toBe('button')
})
