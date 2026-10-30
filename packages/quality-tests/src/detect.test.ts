import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { detectTestSetup, frameworkFor } from './detect.ts'

const dirs: string[] = []

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hk-detect-'))
  dirs.push(dir)
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), content)
    }),
  )
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const bunTest =
  "import { describe, expect, test } from 'bun:test'\n\nimport { add } from './math.ts'\n\ntest('add', () => {\n  expect(add(1, 2)).toBe(3)\n})\n"

describe('detectTestSetup', () => {
  test('bun:test from imports, colocated, with samples', async () => {
    const dir = await project({
      'package.json': JSON.stringify({ devDependencies: { '@types/bun': '1' } }),
      'bun.lock': '',
      'src/math.ts': 'export const add = (a: number, b: number) => a + b\n',
      'src/math.test.ts': bunTest,
      'src/util/strings.test.ts': bunTest,
      'node_modules/x/a.test.ts': "import { test } from 'vitest'\n",
    })
    const setup = await detectTestSetup(dir)
    expect(setup.frameworks[0]?.framework).toBe('bun:test')
    expect(setup.frameworks.map((entry) => entry.framework)).toEqual(['bun:test'])
    expect(setup.testFiles).toBe(2)
    expect(setup.conventions).toEqual([
      {
        language: 'js',
        layout: 'colocated',
        fileName: '{name}.test.ts',
        frameworkImport: "import { describe, expect, test } from 'bun:test'",
        localImportExtension: '.ts',
      },
    ])
    expect(setup.samples.toSorted()).toEqual(['src/math.test.ts', 'src/util/strings.test.ts'])
  })

  test('vitest from dependencies and config, tests in test/', async () => {
    const dir = await project({
      'package.json': JSON.stringify({
        devDependencies: { vitest: '3' },
        scripts: { test: 'vitest run' },
      }),
      'vitest.config.ts': 'export default {}\n',
      'src/a.ts': 'export function a() {}\n',
      'test/a.spec.ts':
        "import { expect, it } from 'vitest'\nimport { a } from '../src/a'\nit('a', () => expect(a()).toBeUndefined())\n",
    })
    const setup = await detectTestSetup(dir)
    expect(frameworkFor(setup, 'js')).toBe('vitest')
    expect(setup.frameworks[0]?.evidence).toContain('package.json depends on vitest')
    expect(setup.conventions[0]).toMatchObject({
      layout: 'test-dir',
      testDir: 'test',
      fileName: '{name}.spec.ts',
      localImportExtension: 'none',
    })
  })

  test('jest with globals in __tests__', async () => {
    const dir = await project({
      'package.json': JSON.stringify({
        devDependencies: { jest: '30' },
        scripts: { test: 'jest' },
      }),
      'lib/a.js': 'module.exports = () => 1\n',
      'lib/__tests__/a.test.js':
        "const a = require('../a')\ntest('a', () => expect(a()).toBe(1))\n",
    })
    const setup = await detectTestSetup(dir)
    expect(frameworkFor(setup, 'js')).toBe('jest')
    expect(setup.conventions[0]).toMatchObject({ layout: '__tests__', fileName: '{name}.test.js' })
  })

  test('mocha and node:test', async () => {
    const mocha = await project({
      'package.json': JSON.stringify({ devDependencies: { mocha: '11' } }),
      '.mocharc.json': '{}',
      'test/a.test.js': "describe('a', () => {})\n",
    })
    expect(frameworkFor(await detectTestSetup(mocha), 'js')).toBe('mocha')

    const node = await project({
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      'src/a.test.mjs':
        "import test from 'node:test'\nimport assert from 'node:assert'\ntest('a', () => assert.ok(true))\n",
    })
    expect(frameworkFor(await detectTestSetup(node), 'js')).toBe('node:test')
  })

  test('go test and pytest side by side', async () => {
    const dir = await project({
      'go.mod': 'module example.com/x\n',
      'calc/calc.go': 'package calc\n',
      'calc/calc_test.go': 'package calc\n',
      'pyproject.toml': '[tool.pytest.ini_options]\n',
      'shop/cart.py': 'def total(): pass\n',
      'tests/test_cart.py': 'import pytest\n\ndef test_total():\n    assert True\n',
    })
    const setup = await detectTestSetup(dir)
    expect(frameworkFor(setup, 'go')).toBe('go test')
    expect(frameworkFor(setup, 'python')).toBe('pytest')
    expect(setup.conventions).toEqual([
      { language: 'go', layout: 'colocated', fileName: '{name}_test.go' },
      { language: 'python', layout: 'test-dir', testDir: 'tests', fileName: 'test_{name}.py' },
    ])
  })

  test('nothing to detect', async () => {
    const dir = await project({ 'README.md': '# x\n' })
    expect(await detectTestSetup(dir)).toEqual({
      frameworks: [],
      conventions: [],
      samples: [],
      testFiles: 0,
    })
  })
})
