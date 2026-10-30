import { expect, test } from 'bun:test'

import { inlineSvgFiles } from './media.ts'

test('picks markup files whose added lines carry inline SVG markup', () => {
  const files = [
    {
      oldPath: 'src/Icon.tsx',
      newPath: 'src/Icon.tsx',
      status: 'modified' as const,
      diff: '@@ -1,2 +1,4 @@\n export const Icon = () => (\n+  <svg viewBox="0 0 24 24">\n+    <path d="M0 0h24" />\n+  </svg>\n',
    },
    {
      oldPath: 'src/util.ts',
      newPath: 'src/util.ts',
      status: 'modified' as const,
      diff: '@@ -1 +1,2 @@\n x\n+const svg = "<svg>"\n',
    },
    {
      oldPath: 'src/App.tsx',
      newPath: 'src/App.tsx',
      status: 'modified' as const,
      diff: '@@ -1 +1,2 @@\n x\n+const a = 1\n',
    },
  ]
  expect(inlineSvgFiles(files)).toEqual([{ path: 'src/Icon.tsx', addedLines: [2, 3, 4] }])
})
