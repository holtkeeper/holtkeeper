import type {
  Card,
  CardBlock,
  CardStep,
  CardTone,
  Form,
  FormField,
  StepStatus,
} from '@holtkeeper/chat'
import { fit, slackLimits, toMrkdwn } from '@holtkeeper/notify'

/** A Block Kit block; kept loose, Slack validates the rest. */
export type SlackBlock = Record<string, unknown>

/** A Block Kit modal view. */
export interface SlackView {
  type: 'modal'
  callback_id: string
  title: { type: 'plain_text'; text: string }
  submit: { type: 'plain_text'; text: string }
  close: { type: 'plain_text'; text: string }
  private_metadata: string
  blocks: SlackBlock[]
}

/** `action_id` prefix of buttons that run a command line (their `value`). */
export const COMMAND_ACTION = 'holtkeeper:command'
/** `action_id` of buttons that open a form (its JSON is the `value`). */
export const FORM_ACTION = 'holtkeeper:form'
/** `action_id` of link buttons; clicks are ignored. */
export const LINK_ACTION = 'holtkeeper:link'
/** `callback_id` of form modals. */
export const FORM_VIEW = 'holtkeeper:form'

const limits = {
  blocks: 50,
  actions: 25,
  value: 2000,
  modalTitle: 24,
  option: 75,
  options: 100,
  metadata: 3000,
}

const toneIcons: Record<CardTone, string> = {
  neutral: '',
  info: '🔵',
  good: '🟢',
  warning: '🟠',
  bad: '🔴',
}

const stepIcons: Record<StepStatus, string> = {
  pending: '⚪',
  waiting: '⏸️',
  active: '🔵',
  running: '🔄',
  done: '✅',
  failed: '❌',
  skipped: '⏭️',
}

/** Steps with links get a section and a button each up to this many; more share one section. */
const STEP_BUTTONS = 10

const plain = (text: string, max: number) => ({
  type: 'plain_text',
  text: fit(text, max),
  emoji: true,
})
const mrkdwn = (text: string) => ({
  type: 'mrkdwn',
  text: fit(toMrkdwn(text), slackLimits.section),
})
const section = (text: string): SlackBlock => ({ type: 'section', text: mrkdwn(text) })
const link = (text: string, url: string | undefined) => (url ? `[${text}](${url})` : text)

const formTemplate = (form: Form, prefix: string) =>
  [
    `/${prefix} ${form.command}`,
    ...form.fields
      .filter((field) => field.kind === 'toggle' || !field.optional)
      .map((field) => `${field.name}=<${field.name}>`),
  ].join(' ')

const blocksOf = (part: CardBlock, prefix: string): SlackBlock[] => {
  switch (part.type) {
    case 'text':
      return part.text ? [section(part.text)] : []
    case 'context':
      return [{ type: 'context', elements: [mrkdwn(part.text)] }]
    case 'fields': {
      const fields = part.fields.slice(0, slackLimits.fields)
      const out: SlackBlock[] = []
      for (let index = 0; index < fields.length; index += slackLimits.fieldsPerSection)
        out.push({
          type: 'section',
          fields: fields.slice(index, index + slackLimits.fieldsPerSection).map((field) => ({
            type: 'mrkdwn',
            text: fit(toMrkdwn(`**${field.label}**\n${field.value}`), slackLimits.field),
          })),
        })
      return out
    }
    case 'heading': {
      const icon = part.tone ? toneIcons[part.tone] : ''
      return [
        section(
          `${icon ? `${icon} ` : ''}**${part.text}**${part.detail ? `   ·   ${part.detail}` : ''}`,
        ),
      ]
    }
    case 'divider':
      return [{ type: 'divider' }]
    case 'steps': {
      const line = (step: CardStep) =>
        `${stepIcons[step.status]}  **${step.label}**${step.detail ? `  —  ${step.detail}` : ''}`
      if (part.layout === 'flow')
        return [
          {
            type: 'context',
            elements: [
              mrkdwn(
                part.steps.map((step) => `${stepIcons[step.status]} ${step.label}`).join('   →   '),
              ),
            ],
          },
        ]
      if (part.steps.some((step) => step.url) && part.steps.length <= STEP_BUTTONS)
        return part.steps.map((step) => ({
          type: 'section',
          text: mrkdwn(line(step)),
          ...(step.url &&
            step.url.length <= slackLimits.url && {
              accessory: {
                type: 'button',
                action_id: `${LINK_ACTION}:${step.label}`.slice(0, 255),
                text: plain(step.urlLabel ?? 'Open', slackLimits.button),
                url: step.url,
              },
            }),
        }))
      return [section(part.steps.map(line).join('\n'))]
    }
    case 'list':
      return [
        section(
          part.items
            .map((item) => {
              const icon = item.tone ? toneIcons[item.tone] : ''
              return `- ${icon ? `${icon} ` : ''}${link(item.text, item.url)}`
            })
            .join('\n'),
        ),
      ]
    case 'actions': {
      const buttons = part.actions
        .filter((action) => action.command.length <= limits.value)
        .slice(0, limits.actions)
        .map((action, index) => ({
          type: 'button',
          action_id: `${COMMAND_ACTION}:${index}`,
          text: plain(action.label, slackLimits.button),
          value: action.command,
          ...(action.style && { style: action.style }),
          ...(action.style === 'danger' && {
            confirm: {
              title: plain('Are you sure?', 100),
              text: {
                type: 'mrkdwn',
                text: fit(`*${action.label}*\n\`/${prefix} ${action.command}\``, 300),
              },
              confirm: plain('Yes', 30),
              deny: plain('Cancel', 30),
              style: 'danger',
            },
          }),
        }))
      return buttons.length ? [{ type: 'actions', elements: buttons }] : []
    }
    case 'form': {
      const value = JSON.stringify(part.form)
      if (value.length > limits.value)
        return [section(`**${part.form.submitLabel}**: \`${formTemplate(part.form, prefix)}\``)]
      return [
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              action_id: FORM_ACTION,
              text: plain(`${part.form.submitLabel}…`, slackLimits.button),
              value,
              style: 'primary',
            },
          ],
        },
      ]
    }
    default:
      return []
  }
}

/**
 * A card as a Slack message: a `header` with the tone icon, sections in mrkdwn (converted and
 * escaped by `toMrkdwn` of `@holtkeeper/notify`, so cards cannot mention people), fields in
 * sections of ten, buttons that carry their command line (danger buttons ask first), a button that
 * opens each form as a modal, the card link as a link button. At most 50 blocks; `text` is the
 * notification fallback.
 */
export function renderSlackMessage(
  card: Card,
  options: { prefix?: string } = {},
): { text: string; blocks: SlackBlock[] } {
  const prefix = options.prefix ?? 'holtkeeper'
  const icon = card.tone ? toneIcons[card.tone] : ''
  const blocks: SlackBlock[] = [
    ...(card.title
      ? [
          {
            type: 'header',
            text: plain(`${icon ? `${icon} ` : ''}${card.title}`, slackLimits.header),
          },
        ]
      : []),
    ...(card.subtitle ? [{ type: 'context', elements: [mrkdwn(card.subtitle)] }] : []),
    ...card.blocks.flatMap((part) => blocksOf(part, prefix)),
  ]
  if (card.url && card.url.length <= slackLimits.url) {
    const open = {
      type: 'button',
      action_id: LINK_ACTION,
      text: plain('Open in Holtkeeper', slackLimits.button),
      url: card.url,
    }
    const last = blocks.at(-1)
    const elements = last?.['type'] === 'actions' ? last['elements'] : undefined
    if (Array.isArray(elements) && elements.length < limits.actions) elements.push(open)
    else blocks.push({ type: 'actions', elements: [open] })
  }
  const firstText = card.blocks.find((part) => part.type === 'text')
  const text = card.title ?? (firstText?.type === 'text' ? firstText.text : 'Holtkeeper')
  return { text: fit(text, slackLimits.section), blocks: blocks.slice(0, limits.blocks) }
}

const option = (value: string, label: string, description?: string) => ({
  text: plain(label, limits.option),
  value,
  ...(description && { description: plain(description, limits.option) }),
})

const inputOf = (field: FormField): SlackBlock => {
  const base = { type: 'input', block_id: field.name, label: plain(field.label, 2000) }
  if (field.kind === 'text')
    return {
      ...base,
      optional: field.optional ?? false,
      element: {
        type: 'plain_text_input',
        action_id: 'value',
        multiline: field.multiline ?? false,
        ...(field.initial && { initial_value: field.initial }),
        ...(field.placeholder && { placeholder: plain(field.placeholder, 150) }),
      },
    }
  if (field.kind === 'toggle')
    return {
      ...base,
      optional: true,
      element: {
        type: 'checkboxes',
        action_id: 'value',
        options: [option('true', field.label)],
        ...(field.initial && { initial_options: [option('true', field.label)] }),
      },
    }
  const options = field.options
    .slice(0, limits.options)
    .map((choice) => option(choice.value, choice.label, choice.description))
  const initial = [field.initial ?? []]
    .flat()
    .map((value) => options.find((choice) => choice.value === value))
    .filter((choice) => choice !== undefined)
  return {
    ...base,
    optional: field.optional ?? false,
    element: field.multiple
      ? {
          type: 'multi_static_select',
          action_id: 'value',
          options,
          ...(initial.length && { initial_options: initial }),
        }
      : {
          type: 'static_select',
          action_id: 'value',
          options,
          ...(initial[0] && { initial_option: initial[0] }),
        },
  }
}

/** A form as a modal; `metadata` comes back with the submission (at most 3000 characters). */
export function formView(form: Form, metadata: string): SlackView {
  if (metadata.length > limits.metadata) throw new Error('form metadata is too long for Slack')
  return {
    type: 'modal',
    callback_id: FORM_VIEW,
    title: { type: 'plain_text', text: fit(form.submitLabel, limits.modalTitle) },
    submit: { type: 'plain_text', text: fit(form.submitLabel, limits.modalTitle) },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: metadata,
    blocks: form.fields.map(inputOf),
  }
}

interface SlackStateValue {
  value?: string | null
  selected_option?: { value: string } | null
  selected_options?: { value: string }[]
}

/** The values of a submitted form modal by field name, for `formCommand`. */
export function formValues(
  form: Form,
  state: Record<string, Record<string, SlackStateValue>>,
): Record<string, string | string[] | boolean | undefined> {
  const values: Record<string, string | string[] | boolean | undefined> = {}
  for (const field of form.fields) {
    const input = state[field.name]?.['value']
    if (field.kind === 'toggle') values[field.name] = (input?.selected_options ?? []).length > 0
    else if (field.kind === 'select' && field.multiple)
      values[field.name] = (input?.selected_options ?? []).map((choice) => choice.value)
    else if (field.kind === 'select')
      values[field.name] = input?.selected_option?.value ?? undefined
    else values[field.name] = input?.value ?? undefined
  }
  return values
}
