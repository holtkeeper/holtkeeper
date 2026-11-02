import { expect, test } from 'bun:test'

import type { ChatForm, ChatMessageView } from '@holtkeeper/api'

import {
  formCommand,
  hasLiveCards,
  initialValues,
  matchingCommands,
  missingFields,
  withoutPrefix,
} from './chat.ts'

const form: ChatForm = {
  command: 'release deploy',
  submitLabel: 'Deploy',
  fields: [
    {
      kind: 'select',
      name: 'environment',
      label: 'Environment',
      options: [{ value: 'qa', label: 'QA' }],
      initial: 'qa',
    },
    { kind: 'select', name: 'repos', label: 'Repositories', options: [], multiple: true },
    { kind: 'text', name: 'note', label: 'Note', optional: true },
    { kind: 'toggle', name: 'force', label: 'Ignore gates' },
  ],
}

test('forms start from their initial values and report missing fields', () => {
  const values = initialValues(form)
  expect(values).toEqual({ environment: 'qa', repos: [], force: false })
  expect(missingFields(form, values)).toEqual(['Repositories'])
  expect(missingFields(form, { ...values, repos: ['a'] })).toEqual([])
})

test('form commands match the server format', () => {
  expect(
    formCommand(form, { environment: 'qa', repos: ['a', 'b'], note: 'after "lunch"', force: true }),
  ).toBe('release deploy environment=qa repos=a,b note="after \\"lunch\\"" force=true')
  expect(formCommand(form, { note: '' })).toBe('release deploy')
})

const message = (status: 'running' | 'done', at: string): ChatMessageView => ({
  id: at,
  from: 'holtkeeper',
  at,
  card: { blocks: [{ type: 'steps', steps: [{ label: 'qa', status }] }] },
})
test('live cards are recent cards with unfinished steps', () => {
  const now = new Date('2026-11-02T12:00:00Z')
  expect(hasLiveCards([message('done', '2026-11-02T11:00:00Z')], now)).toBe(false)
  expect(hasLiveCards([message('running', '2026-11-02T11:00:00Z')], now)).toBe(true)
  expect(hasLiveCards([message('running', '2026-10-30T11:00:00Z')], now)).toBe(false)
})

test('hints match the first word, prefix or not', () => {
  const commands = [{ name: 'release' }, { name: 'help' }]
  expect(withoutPrefix('/holtkeeper release deploy')).toBe('release deploy')
  expect(matchingCommands(commands, '/holtkeeper re').map((c) => c.name)).toEqual(['release'])
  expect(matchingCommands(commands, '').map((c) => c.name)).toEqual(['release', 'help'])
  expect(matchingCommands(commands, 'release deploy')).toEqual([])
})
