import { describe, expect, test } from 'bun:test'

import type { Card, Form } from '@holtkeeper/chat'

import { COMMAND_ACTION, FORM_ACTION, formValues, formView, renderSlackMessage } from './blocks.ts'

const form: Form = {
  command: 'release deploy',
  submitLabel: 'Deploy',
  fields: [
    {
      kind: 'select',
      name: 'environment',
      label: 'Environment',
      options: [
        { value: 'qa', label: 'QA' },
        { value: 'prod', label: 'Production' },
      ],
      initial: 'qa',
    },
    {
      kind: 'select',
      name: 'repos',
      label: 'Repositories',
      options: [{ value: 'a', label: 'A' }],
      multiple: true,
    },
    { kind: 'text', name: 'note', label: 'Note', optional: true, multiline: true },
    { kind: 'toggle', name: 'force', label: 'Ignore gates' },
  ],
}

describe('blocks', () => {
  const card: Card = {
    title: 'Release games/app-x',
    tone: 'warning',
    url: 'https://holt.example/release-board/repo?repo=work%3Agames%2Fapp-x',
    blocks: [
      { type: 'text', text: 'Hi <!channel> **now**' },
      { type: 'fields', fields: [{ label: 'Next', value: '`1.3.0`' }] },
      {
        type: 'steps',
        steps: [
          { label: 'qa', status: 'done', url: 'https://ci.example/1' },
          { label: 'prod', status: 'running', detail: 'deploying' },
        ],
      },
      { type: 'list', items: [{ text: 'pipeline failed', tone: 'bad' }] },
      {
        type: 'actions',
        actions: [
          { label: 'Create v1.3.0', command: 'release version', style: 'primary' },
          { label: 'Deploy', command: 'release deploy prod --yes', style: 'danger' },
        ],
      },
      { type: 'form', form },
      { type: 'context', text: 'dry run' },
    ],
  }

  test('renders every block, escapes text and carries commands in buttons', () => {
    const { text, blocks } = renderSlackMessage(card)
    expect(text).toBe('Release games/app-x')
    expect(blocks.map((block) => block['type'])).toEqual([
      'header',
      'section',
      'section',
      'section',
      'section',
      'section',
      'actions',
      'actions',
      'context',
      'actions',
    ])
    expect(blocks[0]).toEqual({
      type: 'header',
      text: { type: 'plain_text', text: '🟠 Release games/app-x', emoji: true },
    })
    expect(JSON.stringify(blocks[1])).toContain('Hi &lt;!channel&gt; *now*')
    expect(blocks[3]).toMatchObject({
      text: { text: '✅  *qa*' },
      accessory: { type: 'button', text: { text: 'Open' }, url: 'https://ci.example/1' },
    })
    expect(blocks[4]).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: '🔄  *prod*  —  deploying' },
    })
    const [create, deploy] = (blocks[6]?.['elements'] ?? []) as Record<string, unknown>[]
    expect(create).toMatchObject({
      action_id: `${COMMAND_ACTION}:0`,
      value: 'release version',
      style: 'primary',
    })
    expect(create?.['confirm']).toBeUndefined()
    expect(deploy).toMatchObject({ value: 'release deploy prod --yes', style: 'danger' })
    expect(deploy?.['confirm']).toBeDefined()
    const [open] = (blocks[7]?.['elements'] ?? []) as Record<string, unknown>[]
    expect(open).toMatchObject({ action_id: FORM_ACTION })
    expect(JSON.parse(String(open?.['value']))).toEqual(form)
    expect(JSON.stringify(blocks[9])).toContain(card.url ?? '')
  })

  test('subtitles, headings, dividers, flows and the link beside the buttons', () => {
    const { blocks } = renderSlackMessage({
      title: 'Release · games/app-x',
      subtitle: 'Merged changes wait for a version',
      url: 'https://holt.example/r',
      blocks: [
        {
          type: 'steps',
          layout: 'flow',
          steps: [
            { label: 'Changes', status: 'done' },
            { label: 'Version', status: 'active' },
            { label: 'Deploy', status: 'pending' },
          ],
        },
        { type: 'heading', text: 'Gates', detail: '1 failing', tone: 'bad' },
        { type: 'divider' },
        { type: 'actions', actions: [{ label: 'Create v1.3.0', command: 'release version' }] },
      ],
    })
    expect(blocks.map((block) => block['type'])).toEqual([
      'header',
      'context',
      'context',
      'section',
      'divider',
      'actions',
    ])
    expect(JSON.stringify(blocks[1])).toContain('Merged changes wait for a version')
    expect(JSON.stringify(blocks[2])).toContain('✅ Changes   →   🔵 Version   →   ⚪ Deploy')
    expect(JSON.stringify(blocks[3])).toContain('🔴 *Gates*   ·   1 failing')
    expect(blocks[5]?.['elements']).toHaveLength(2)
  })

  test('forms become modals and their state becomes values', () => {
    const view = formView(form, '{}')
    expect(view.blocks.map((block) => (block['element'] as { type: string }).type)).toEqual([
      'static_select',
      'multi_static_select',
      'plain_text_input',
      'checkboxes',
    ])
    expect(view.blocks[0]).toMatchObject({ element: { initial_option: { value: 'qa' } } })
    expect(
      formValues(form, {
        environment: { value: { selected_option: { value: 'prod' } } },
        repos: { value: { selected_options: [{ value: 'a' }] } },
        note: { value: { value: null } },
        force: { value: { selected_options: [] } },
      }),
    ).toEqual({ environment: 'prod', repos: ['a'], note: undefined, force: false })
  })
})
