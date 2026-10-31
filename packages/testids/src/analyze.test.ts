import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { analyzeTestIds, componentName, findUntagged, tsconfigAliases } from './analyze.ts'
import { testIdsCheck } from './check.ts'
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
        <p data-test-id="status" data-test-state={state} data-qa={\`row-\${id}\`} />
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

test('lists test attributes per component with static and runtime values', async () => {
  const data = await analyzeTestIds({ dir })
  expect(data.components.map((c) => [c.name, c.file, c.source, c.total])).toEqual([
    ['Form', 'src/Form.tsx', 'jsx', 2],
    ['Menu', 'src/Menu.vue', 'vue', 1],
  ])
  expect(data.components[0]?.elements).toEqual([
    { line: 6, tag: 'input', attributes: [{ name: 'data-testid', value: 'title' }] },
    {
      line: 9,
      tag: 'p',
      attributes: [
        { name: 'data-test-id', value: 'status' },
        { name: 'data-test-state', value: 'state', dynamic: true },
        { name: 'data-qa', value: '`row-${id}`', dynamic: true },
      ],
    },
  ])

  const report = testIdsReport(data, { generatedAt: '2026-10-30T00:00:00Z' })
  expect(report.metrics.map((m) => [m.id, m.value])).toEqual([
    ['components', 2],
    ['elements', 3],
    ['attributes', 5],
  ])
  expect(report.sections.map((s) => s.id)).toEqual(['attributes', 'components'])

  const previous = await analyzeTestIds({ dir, exclude: ['src/*.vue'] })
  const changes = testIdsReport(data, { previous }).sections.at(-1)
  expect(changes?.blocks[0]).toMatchObject({
    type: 'table',
    rows: [{ component: 'Menu · src/Menu.vue', selector: '[data-test="toggle"]' }],
  })
})

test('names components after files, or their folder for index files', () => {
  expect(
    [
      'src/LoginForm.tsx',
      'src/cart/index.vue',
      'src/routes/+page.svelte',
      'app/a.component.html',
    ].map(componentName),
  ).toEqual(['LoginForm', 'cart', 'routes', 'a'])
})

test('finds interactive elements without a test attribute through linaria styles', async () => {
  const found = await findUntagged({ dir })
  expect(found.map((e) => [e.file, e.line, e.tag, e.as, e.reason, e.status])).toEqual([
    ['src/Form.tsx', 4, 'form', undefined, 'submit handler', 'missing'],
    ['src/Form.tsx', 7, 'S.Submit', 'button', 'button', 'missing'],
    ['src/Form.tsx', 8, 'S.Row', 'div', 'click handler', 'unverified'],
    ['src/Menu.vue', 6, 'router-link', undefined, 'to', 'missing'],
    ['src/Toggle.svelte', 2, 'button', undefined, 'button', 'missing'],
  ])
  const mapped = await findUntagged({
    dir,
    components: { 'router-link': 'a' },
    exclude: ['src/*.svelte', 'src/*.tsx'],
  })
  expect(mapped).toMatchObject([{ tag: 'router-link', as: 'a', reason: 'a' }])
})

test('the check reports missing test ids with the project convention', async () => {
  const check = testIdsCheck()
  expect(await check.detect(dir)).toBe(true)
  const result = await check.run({ dir, runner: undefined as never })
  expect(result.issues?.map((issue) => [issue.file, issue.range?.start.line])).toEqual([
    ['src/Form.tsx', 4],
    ['src/Form.tsx', 7],
    ['src/Menu.vue', 6],
    ['src/Toggle.svelte', 2],
  ])
  expect(result.issues?.[1]?.help).toContain('this component already uses `data-test-id="status"`')
  expect(result.issues?.[3]?.help).toContain('e.g.')
  const none = await testIdsCheck({ attributes: ['data-e2e'] }).run({
    dir,
    runner: undefined as never,
  })
  expect(none.skipped).toBeDefined()
})
