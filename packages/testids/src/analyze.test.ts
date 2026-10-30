import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { analyzeTestIds, tsconfigAliases } from './analyze.ts'
import { testIdsReport } from './report.ts'

let dir: string

const files: Record<string, string> = {
  'tsconfig.json': `{
  // comments and trailing commas are fine
  "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["./src/*"], }, },
}`,
  'src/ui/styles.ts': `import { styled } from '@linaria/react'
export const Submit = styled.button\`\`
export const Row = styled.div\`\`
`,
  'src/Form.tsx': `import * as S from '~/ui/styles'
export function Form({ onSave, ...rest }) {
  return (
    <form onSubmit={onSave}>
      <S.Row>
        <input name="title" data-testid="title" />
        <S.Submit>Save</S.Submit>
        <S.Row onClick={onSave} {...rest} />
      </S.Row>
    </form>
  )
}
`,
  'src/Form.test.tsx': `test('x', () => render(<button>never counted</button>))`,
  'src/Form.stories.tsx': `export const A = () => <button>never counted</button>`,
  'src/Menu.vue': `<script setup lang="ts">
const open = ref(1 < 2)
</script>
<template>
  <nav>
    <router-link to="/">Home</router-link>
    <button data-test="toggle" @click="open = !open">Menu</button>
  </nav>
</template>
`,
  'src/Toggle.svelte': `<script>let on = false</script>
<button on:click={() => (on = !on)}>Toggle</button>
`,
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'testids-'))
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true })
    await writeFile(join(dir, file), text)
  }
})

afterAll(() => rm(dir, { recursive: true, force: true }))

test('reads tsconfig paths as aliases', async () => {
  expect(await tsconfigAliases(dir)).toEqual({ '~/': 'src/' })
})

test('finds interactive elements in jsx, vue and svelte through linaria styles', async () => {
  const data = await analyzeTestIds({ dir })
  expect(
    data.files.map((file) => [file.file, file.source, file.total, file.tagged, file.unverified]),
  ).toEqual([
    ['src/Form.tsx', 'jsx', 4, 1, 1],
    ['src/Menu.vue', 'vue', 2, 1, 0],
    ['src/Toggle.svelte', 'svelte', 1, 0, 0],
  ])
  expect(data.files[0]?.elements).toEqual([
    { line: 4, tag: 'form', reason: 'submit handler', status: 'missing' },
    { line: 7, tag: 'S.Submit', as: 'button', reason: 'button', status: 'missing' },
    { line: 8, tag: 'S.Row', as: 'div', reason: 'click handler', status: 'unverified' },
  ])
  expect(data.usage).toMatchObject({ 'data-testid': 1, 'data-test': 1 })

  const report = testIdsReport(data, { generatedAt: '2026-10-30T00:00:00Z' })
  expect(report.metrics.map((m) => [m.id, m.value])).toEqual([
    ['tagged', (2 / 7) * 100],
    ['elements', 7],
    ['missing', 4],
    ['unverified', 1],
  ])
  expect(report.sections.map((s) => s.id)).toEqual(['overview', 'files', 'elements'])
})

test('a configured attribute list and component map change the verdict', async () => {
  const data = await analyzeTestIds({
    dir,
    attributes: ['data-test'],
    components: { 'router-link': 'a' },
    exclude: ['src/*.svelte'],
  })
  expect(data.files.map((file) => [file.file, file.total, file.tagged])).toEqual([
    ['src/Form.tsx', 4, 0],
    ['src/Menu.vue', 2, 1],
  ])
  expect(data.files[1]?.elements[0]).toMatchObject({ tag: 'router-link', as: 'a', reason: 'a' })
})
