import { describe, expect, test } from 'bun:test'

import { mergeToolchain, miseExecArgs, miseToolSpecs } from './merge.ts'
import { toolchainOverrideSchema, toolchainSetting } from './types.ts'

const detected = {
  tools: [
    { name: 'node', version: '20', source: '.nvmrc' },
    { name: 'pnpm', version: '9.12.0', source: 'package.json' },
    { name: 'python', version: '3.12', source: 'pyproject.toml' },
  ],
  packageManager: { name: 'pnpm', version: '9.12.0' },
  notes: ['a note'],
}

describe('mergeToolchain', () => {
  test('without an override keeps everything', () => {
    expect(mergeToolchain(detected, undefined)).toEqual({ ...detected, env: {} })
  })

  test('replaces, removes and adds tools; takes image, network and env', () => {
    const merged = mergeToolchain(detected, {
      tools: { node: '22', python: 'none', go: '1.23', pnpm: '10.0.0' },
      image: 'registry.test/worker:1',
      network: 'full',
      env: { CI: '1' },
    })
    expect(merged).toEqual({
      tools: [
        { name: 'node', version: '22', source: 'setting' },
        { name: 'pnpm', version: '10.0.0', source: 'setting' },
        { name: 'go', version: '1.23', source: 'setting' },
      ],
      packageManager: { name: 'pnpm', version: '10.0.0' },
      notes: ['a note'],
      image: 'registry.test/worker:1',
      network: 'full',
      env: { CI: '1' },
    })
    expect(detected.tools).toHaveLength(3)
  })
})

test('miseExecArgs', () => {
  expect(miseExecArgs(detected)).toEqual([
    'mise',
    'exec',
    'node@20',
    'pnpm@9.12.0',
    'python@3.12',
    '--',
  ])
  expect(miseExecArgs({ tools: [] })).toEqual(['mise', 'exec', '--'])
  expect(miseToolSpecs(detected)).toEqual(['node@20', 'pnpm@9.12.0', 'python@3.12'])
})

describe('toolchain setting', () => {
  test('is shaped like a setting definition', () => {
    expect(toolchainSetting).toMatchObject({ key: 'toolchain', section: 'Runtime' })
  })

  test('validates overrides', () => {
    expect(
      toolchainOverrideSchema.safeParse({ tools: { node: '20' }, network: 'none' }).success,
    ).toBe(true)
    expect(toolchainOverrideSchema.safeParse({ network: 'bridge' }).success).toBe(false)
    expect(toolchainOverrideSchema.safeParse({ env: { 'BAD-NAME': 'x' } }).success).toBe(false)
    expect(toolchainOverrideSchema.safeParse({ tools: { node: '' } }).success).toBe(false)
  })
})
