import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { Finding } from '@holtkeeper/vuln'

import { goEnv, goFixer } from './fixer.ts'

function finding(id: string, name: string, fixed: string): Finding {
  return {
    id,
    aliases: [],
    summary: '',
    severity: 'high',
    url: '',
    package: { name, version: '0.1.0', ecosystem: 'Go' },
    source: 'svc/go.mod',
    fixedVersions: [fixed],
  }
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holtkeeper-vuln-go-'))
  await Bun.write(join(dir, 'svc/go.mod'), 'module example.com/svc\n')
})

afterEach(() => rm(dir, { recursive: true, force: true }))

describe('goFixer', () => {
  test('supports go.mod files only', () => {
    const fixer = goFixer()
    expect(fixer.supports('go.mod')).toBe(true)
    expect(fixer.supports('svc/go.mod')).toBe(true)
    expect(fixer.supports('go.sum')).toBe(false)
    expect(fixer.supports('package-lock.json')).toBe(false)
  })

  test('runs go get per module and go mod tidy in the module directory', async () => {
    const { runner, calls } = createFakeRunner(async (command) => {
      if (command[1] === 'mod') await Bun.write(join(dir, 'svc/go.sum'), 'sum\n')
      return undefined
    })
    const result = await goFixer({ runner }).fix({
      dir,
      source: 'svc/go.mod',
      findings: [
        finding('GO-1', 'example.com/a', '0.2.0'),
        finding('GO-2', 'stdlib', '1.27.3'),
        finding('GO-3', 'example.com/b', 'v1.0.0'),
      ],
    })

    expect(calls.map((call) => call.command)).toEqual([
      ['go', 'get', 'example.com/a@v0.2.0'],
      ['go', 'get', 'example.com/b@v1.0.0'],
      ['go', 'mod', 'tidy'],
    ])
    for (const call of calls) {
      expect(call.options.cwd).toBe(join(dir, 'svc'))
      expect(call.options.env).toEqual(goEnv)
    }
    expect(result).toEqual({
      changedFiles: ['svc/go.sum'],
      fixed: ['GO-1', 'GO-3'],
      notes: ['stdlib: upgrade the Go toolchain to go1.27.3 or later (GO-2)'],
    })
  })

  test('reports a failed go get as a note and keeps going', async () => {
    const { runner, calls } = createFakeRunner((command) =>
      command[2]?.startsWith('example.com/a@') ? { exitCode: 1, stderr: 'no such version' } : {},
    )
    const result = await goFixer({ runner }).fix({
      dir,
      source: 'svc/go.mod',
      findings: [
        finding('GO-1', 'example.com/a', '0.2.0'),
        finding('GO-2', 'example.com/b', '0.3.0'),
      ],
    })
    expect(calls).toHaveLength(3)
    expect(result.fixed).toEqual(['GO-2'])
    expect(result.notes).toEqual(['`go get example.com/a@v0.2.0` exited with 1:\nno such version'])
  })

  test('runs nothing when there is nothing to upgrade', async () => {
    const { runner, calls } = createFakeRunner()
    const result = await goFixer({ runner }).fix({
      dir,
      source: 'svc/go.mod',
      findings: [finding('GO-1', 'stdlib', '1.27.3')],
    })
    expect(calls).toEqual([])
    expect(result.changedFiles).toEqual([])
    expect(result.fixed).toEqual([])
  })
})
