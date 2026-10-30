import { describe, expect, test } from 'bun:test'

import { type FileAccess, type CodeChange, planChanges } from '@holtkeeper/changes'

import { type DependencyField, removeDependencyEdit } from './package-json.ts'

const memory = (text: string): FileAccess => ({ read: async () => text })

async function remove(text: string, names: string[], field: DependencyField = 'dependencies') {
  const changes: CodeChange[] = names.map((name) => {
    const index = text.indexOf(`"${name}"`, text.indexOf(`"${field}"`)) + 1
    const before = text.slice(0, index)
    const at = { line: before.split('\n').length, column: index - before.lastIndexOf('\n') }
    const edit = removeDependencyEdit(text, 'package.json', field, name, at)
    if (!edit) throw new Error(`no edit for ${name}`)
    return { id: name, title: name, confidence: 'review', source: 'knip', edits: [edit] }
  })
  const plan = await planChanges(changes, memory(text))
  return { text: plan.files[0]?.content ?? text, conflicts: plan.conflicts.map((c) => c.changeId) }
}

const manifest = `{
  "name": "x",
  "dependencies": {
    "a": "^1.0.0",
    "b": "^2.0.0",
    "c": "^3.0.0"
  },
  "devDependencies": {
    "a": "^1.0.0"
  }
}
`

describe('removeDependencyEdit', () => {
  test('removes a middle entry with its line', async () => {
    expect((await remove(manifest, ['b'])).text).toBe(manifest.replace('    "b": "^2.0.0",\n', ''))
  })

  test('removes the last entry together with the comma before it', async () => {
    const { text } = await remove(manifest, ['c'])
    expect(text).toContain('"b": "^2.0.0"\n  },')
    expect(JSON.parse(text).dependencies).toEqual({ a: '^1.0.0', b: '^2.0.0' })
  })

  test('leaves {} after removing the only entry', async () => {
    const { text } = await remove(manifest, ['a'], 'devDependencies')
    expect(text).toContain('"devDependencies": {}\n')
    expect(JSON.parse(text).dependencies.a).toBe('^1.0.0')
  })

  test('combines removals of non-adjacent and leading entries', async () => {
    const { text, conflicts } = await remove(manifest, ['a', 'c'])
    expect(conflicts).toEqual([])
    expect(JSON.parse(text).dependencies).toEqual({ b: '^2.0.0' })
    expect((await remove(manifest, ['a', 'b'])).text).toContain('{\n    "c": "^3.0.0"\n  }')
  })

  test('removing the last two entries at once conflicts instead of breaking JSON', async () => {
    const { text, conflicts } = await remove(manifest, ['b', 'c'])
    expect(conflicts).toEqual(['c'])
    expect(JSON.parse(text).dependencies).toEqual({ a: '^1.0.0', c: '^3.0.0' })
  })

  test('handles single-line objects and CRLF', async () => {
    const inline = '{"dependencies": {"a": "1", "b": "2", "c": "3"}}'
    expect((await remove(inline, ['b'])).text).toBe('{"dependencies": {"a": "1", "c": "3"}}')
    expect((await remove(inline, ['c'])).text).toBe('{"dependencies": {"a": "1", "b": "2"}}')
    const crlf = manifest.replaceAll('\n', '\r\n')
    expect(JSON.parse((await remove(crlf, ['b'])).text).dependencies).toEqual({
      a: '^1.0.0',
      c: '^3.0.0',
    })
  })

  test('uses knip position to pick the key when the name occurs in several fields', () => {
    expect(removeDependencyEdit(manifest, 'package.json', 'devDependencies', 'a')).toBeUndefined()
    const edit = removeDependencyEdit(manifest, 'package.json', 'devDependencies', 'a', {
      line: 9,
      column: 6,
    })
    expect(edit?.range.start.line).toBe(8)
  })

  test('refuses names that are not listed or whose value is not a string', () => {
    expect(removeDependencyEdit(manifest, 'package.json', 'dependencies', 'zzz')).toBeUndefined()
    const odd = '{"dependencies": {"a": {"version": "1"}}}'
    expect(removeDependencyEdit(odd, 'package.json', 'dependencies', 'a')).toBeUndefined()
  })
})
