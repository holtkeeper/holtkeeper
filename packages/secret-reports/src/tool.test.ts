import { expect, test } from 'bun:test'

import { ToolError } from '@holtkeeper/agent-tools'

import type { SecretReportInput } from './model.ts'
import { type SecretReportsAccess, secretReportsToolset } from './tool.ts'

const signal = new AbortController().signal

function setup(mode: SecretReportsAccess['mode'] = 'named', reject?: string) {
  const sent: SecretReportInput[] = []
  const toolset = secretReportsToolset({
    mode,
    pageUrl: 'https://holtkeeper.example.com/secret-reports',
    submit: async (input) => {
      sent.push(input)
      return reject
        ? { status: 'rejected', reason: reject }
        : {
            status: 'reported',
            report: { ...input, id: 'r1', status: 'new', reportedAt: '', repeats: 0 },
          }
    },
  })
  const tool = toolset.tools[0]!
  const run = (args: Record<string, unknown>) =>
    Promise.resolve(tool.run(tool.input.parse(args), { dir: '.', signal }))
  return { toolset, tool, run, sent }
}

const valid = {
  kind: 'api-key',
  identifier: 'WIDGET_API_KEY',
  service: 'api.example.com',
  masked: 'wk_l…(40)',
  channel: 'chat',
}

test('the toolset tells agents to report on their own, masked', () => {
  const { toolset, tool } = setup('anonymous')
  expect(toolset.name).toBe('security')
  expect(toolset.instructions).toContain('report_secret_exposure')
  expect(tool.name).toBe('report_secret_exposure')
  expect(tool.readOnly).toBe(false)
  expect(tool.description).toContain('without waiting to be asked')
  expect(tool.description).toContain('anonymous')
  expect('subject' in tool).toBe(false)
})

test('passes a clean report on and answers with the next step', async () => {
  const { run, sent } = setup()
  const answer = await run({ ...valid, circumstances: '  A .env file was printed.  ' })
  expect(sent).toEqual([{ ...valid, circumstances: 'A .env file was printed.' }] as never)
  expect(answer).toContain("under the user's name")
  expect(answer).toContain('rotated')
})

test('refuses text that holds a value without echoing it', async () => {
  const { run, sent } = setup()
  const value = 'glpat-abcdefghij0123456789'
  const error = await run({ ...valid, circumstances: `The token ${value} was pasted.` }).catch(
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(ToolError)
  expect(String(error)).toContain('circumstances')
  expect(String(error)).not.toContain(value)
  expect(sent).toHaveLength(0)
})

test('refuses masks that show too much and fingerprints of passwords', async () => {
  const { run, sent } = setup()
  expect(run({ ...valid, masked: 'wk_live_1' })).rejects.toThrow('masked')
  expect(
    run({ ...valid, kind: 'password', masked: '…(12)', fingerprint: '0123456789abcdef' }),
  ).rejects.toThrow('passwords')
  expect(run({ ...valid, fingerprint: 'xyz' })).rejects.toThrow('16 hex')
  expect(run({ ...valid, service: undefined })).rejects.toThrow('repo')
  expect(sent).toHaveLength(0)
})

test('passes the server refusal on', async () => {
  const { run } = setup('named', 'the service is not one of the organization.')
  expect(run(valid)).rejects.toThrow('Not reported, nothing was stored: the service')
})
