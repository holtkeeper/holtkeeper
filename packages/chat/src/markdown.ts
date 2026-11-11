import type { Card, CardBlock, CardTone, Form, StepStatus } from './card.ts'

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

/** Breaks `@name` mentions with a zero-width space, so cards never notify people by accident. */
export const muteMentions = (text: string): string =>
  text.replaceAll(/(^|[^\w`])@(?=[\w-])/g, '$1@​')

const link = (text: string, url: string | undefined) => (url ? `[${text}](${url})` : text)

const formText = (form: Form, prefix: string) => {
  const template = [
    `/${prefix} ${form.command}`,
    ...form.fields
      .filter((field) => field.kind === 'toggle' || !field.optional)
      .map((field) => `${field.name}=<${field.name}>`),
  ].join(' ')
  const fields = form.fields.map((field) => {
    if (field.kind === 'select') {
      const choices = field.options.map((option) => `\`${option.value}\``).join(', ')
      return `- \`${field.name}\` — ${field.label}${field.multiple ? ' (comma-separated)' : ''}: ${choices}`
    }
    if (field.kind === 'toggle')
      return `- \`${field.name}\` — ${field.label}: \`true\` or \`false\``
    return `- \`${field.name}\` — ${field.label}${field.optional ? ' (optional)' : ''}`
  })
  return [`**${form.submitLabel}** — reply with \`${template}\``, ...fields].join('\n')
}

const block = (part: CardBlock, prefix: string): string => {
  switch (part.type) {
    case 'text':
      return muteMentions(part.text)
    case 'context':
      return `<sub>${muteMentions(part.text)}</sub>`
    case 'fields':
      return part.fields
        .map((field) => `- **${field.label}:** ${muteMentions(field.value)}`)
        .join('\n')
    case 'heading': {
      const icon = part.tone ? toneIcons[part.tone] : ''
      return `${icon ? `${icon} ` : ''}**${muteMentions(part.text)}**${
        part.detail ? ` · ${muteMentions(part.detail)}` : ''
      }`
    }
    case 'divider':
      return '---'
    case 'steps':
      if (part.layout === 'flow')
        return part.steps
          .map((step) => `${stepIcons[step.status]} ${muteMentions(step.label)}`)
          .join(' → ')
      return part.steps
        .map(
          (step) =>
            `- ${stepIcons[step.status]} **${muteMentions(step.label)}**${
              step.detail ? ` — ${muteMentions(step.detail)}` : ''
            }${step.url ? ` · [${step.urlLabel ?? 'Open'}](${step.url})` : ''}`,
        )
        .join('\n')
    case 'list':
      return part.items
        .map((item) => {
          const icon = item.tone ? toneIcons[item.tone] : ''
          return `- ${icon ? `${icon} ` : ''}${link(muteMentions(item.text), item.url)}`
        })
        .join('\n')
    case 'actions':
      return [
        'Reply with:',
        ...part.actions.map(
          (action) =>
            `- \`/${prefix} ${action.command}\` — ${action.label}${action.style === 'danger' ? ' ⚠️' : ''}`,
        ),
      ].join('\n')
    case 'form':
      return formText(part.form, prefix)
    case 'task':
      return [
        `**Change** (${part.status})`,
        muteMentions(part.summary),
        ...part.repos.map((repo) => {
          const mr = part.mergeRequests?.find((each) => each.repo === repo)
          return mr ? `- \`${repo}\`: [!${mr.id}](${mr.url})` : `- \`${repo}\``
        }),
      ].join('\n')
    default:
      return ''
  }
}

/**
 * A card as GitLab-flavored markdown for merge request notes: a heading with the tone, blocks as
 * paragraphs and lists, buttons and forms as the commands to reply with, the card's link last.
 * Mentions in text are muted.
 */
export function renderMarkdown(card: Card, options: { prefix?: string } = {}): string {
  const prefix = options.prefix ?? 'holtkeeper'
  const icon = card.tone ? toneIcons[card.tone] : ''
  return [
    ...(card.title ? [`#### ${icon ? `${icon} ` : ''}${muteMentions(card.title)}`] : []),
    ...(card.subtitle ? [`<sub>${muteMentions(card.subtitle)}</sub>`] : []),
    ...card.blocks.map((part) => block(part, prefix)).filter((text) => text !== ''),
    ...(card.url ? [`[Open in Holtkeeper](${card.url})`] : []),
  ].join('\n\n')
}
