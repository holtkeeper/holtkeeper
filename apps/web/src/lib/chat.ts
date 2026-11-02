import type { ChatForm, ChatMessageView, ChatStepStatus } from '@holtkeeper/api'

/** Values of a form being filled in, by field name. */
export type FormValues = Record<string, string | string[] | boolean | undefined>

const quote = (value: string) =>
  value === '' || /[\s"']/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value

/**
 * The command line a submitted form runs, as the server's `formCommand` builds it: the form's
 * command and `name=value` per filled field, quoted when needed, several values joined by commas.
 */
export function formCommand(form: ChatForm, values: FormValues): string {
  const parts = [form.command]
  for (const field of form.fields) {
    const value = values[field.name]
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0))
      continue
    parts.push(`${field.name}=${quote(Array.isArray(value) ? value.join(',') : String(value))}`)
  }
  return parts.join(' ')
}

/** The values a form starts with. */
export function initialValues(form: ChatForm): FormValues {
  const values: FormValues = {}
  for (const field of form.fields) {
    if (field.kind === 'toggle') values[field.name] = field.initial ?? false
    else if (field.kind === 'select' && field.multiple)
      values[field.name] = [field.initial ?? []].flat()
    else if (field.initial !== undefined) values[field.name] = [field.initial].flat()[0]
  }
  return values
}

/** Labels of required fields that are still empty. */
export function missingFields(form: ChatForm, values: FormValues): string[] {
  return form.fields
    .filter((field) => field.kind !== 'toggle' && !field.optional)
    .filter((field) => {
      const value = values[field.name]
      return value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
    })
    .map((field) => field.label)
}

const liveStatuses = new Set<ChatStepStatus>(['running', 'pending', 'waiting'])

/** Whether a recent card still shows a step that may change, so the page should poll faster. */
export function hasLiveCards(messages: readonly ChatMessageView[], now: Date, windowHours = 24) {
  const since = now.getTime() - windowHours * 3_600_000
  return messages.some(
    (message) =>
      Date.parse(message.updatedAt ?? message.at) >= since &&
      message.card?.blocks.some(
        (block) =>
          block.type === 'steps' && block.steps.some((step) => liveStatuses.has(step.status)),
      ),
  )
}

/** The text after `/holtkeeper `, so people may type commands with or without the prefix. */
export const withoutPrefix = (text: string) => text.trim().replace(/^\/holtkeeper\s+/, '')

/** Commands whose name starts with the first word typed, for the composer's hints. */
export function matchingCommands<T extends { name: string }>(
  commands: readonly T[],
  text: string,
): T[] {
  const word = withoutPrefix(text).split(/\s/)[0]?.toLowerCase() ?? ''
  if (withoutPrefix(text).includes(' ')) return []
  return commands.filter((command) => command.name.startsWith(word))
}
