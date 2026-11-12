import { expect, test } from 'bun:test'

import { keepKv, updateKv } from './kv.ts'
import { memoryStore } from './memory.ts'

test('updateKv writes the applied value and keepKv leaves the key alone', async () => {
  const kv = memoryStore().kv!
  expect(
    await updateKv(kv, 'widget', (current) => [...((current as string[]) ?? []), 'a']),
  ).toEqual(['a'])
  expect(await updateKv(kv, 'widget', () => keepKv)).toBeUndefined()
  expect(await kv.get('widget')).toEqual(['a'])
  expect(await updateKv(kv, 'gadget', () => keepKv)).toBeUndefined()
  expect(await kv.get('gadget')).toBeUndefined()
})
