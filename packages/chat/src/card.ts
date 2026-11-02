import { z } from 'zod'

/** How good or bad something is; surfaces turn it into a color or an icon. */
export type CardTone = 'neutral' | 'info' | 'good' | 'warning' | 'bad'

/**
 * Where one step of a longer operation stands. `active` is where things are now without anything
 * running (a stage waiting for people), `running` is work in progress.
 */
export type StepStatus =
  | 'pending'
  | 'waiting'
  | 'active'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'

/** One step of an operation, e.g. a deploy to one environment. */
export interface CardStep {
  label: string
  status: StepStatus
  detail?: string
  /** Where to follow it, e.g. the job; surfaces show a small link or button. */
  url?: string
  /** The link's label; default `Open`. */
  urlLabel?: string
}

/**
 * A button. `command` is the full command line it runs (without the `/holtkeeper` prefix), so
 * every surface can offer it: as a button where it has buttons, as a command to reply with where
 * it has not. Whoever clicks is authorized again when the command runs.
 */
export interface CardAction {
  label: string
  command: string
  style?: 'primary' | 'danger'
}

/** One choice of a select field. */
export interface FormOption {
  value: string
  label: string
  description?: string
}

/** A form field. Values reach the command as `name=value` options. */
export type FormField =
  | {
      kind: 'text'
      name: string
      label: string
      placeholder?: string
      multiline?: boolean
      optional?: boolean
      initial?: string
    }
  | {
      kind: 'select'
      name: string
      label: string
      options: FormOption[]
      /** Several values, joined with commas. */
      multiple?: boolean
      optional?: boolean
      initial?: string | string[]
    }
  | { kind: 'toggle'; name: string; label: string; initial?: boolean }

/**
 * Input for a command. Submitting runs `command` with every filled field appended as
 * `name=value`; surfaces without forms show the fields and the command to reply with.
 */
export interface Form {
  command: string
  submitLabel: string
  fields: FormField[]
}

const optionSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
})

/** Validates a `Form` that came back from a surface, e.g. inside a Slack button. */
export const formSchema: z.ZodType<Form> = z.object({
  command: z.string().min(1),
  submitLabel: z.string().min(1),
  fields: z.array(
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('text'),
        name: z.string().min(1),
        label: z.string(),
        placeholder: z.string().optional(),
        multiline: z.boolean().optional(),
        optional: z.boolean().optional(),
        initial: z.string().optional(),
      }),
      z.object({
        kind: z.literal('select'),
        name: z.string().min(1),
        label: z.string(),
        options: z.array(optionSchema),
        multiple: z.boolean().optional(),
        optional: z.boolean().optional(),
        initial: z.union([z.string(), z.array(z.string())]).optional(),
      }),
      z.object({
        kind: z.literal('toggle'),
        name: z.string().min(1),
        label: z.string(),
        initial: z.boolean().optional(),
      }),
    ]),
  ),
})

/** One part of a card. Surfaces render the kinds they support and fall back to text for the rest. */
export type CardBlock =
  | { type: 'text'; text: string }
  /** Starts a part of the card: a short label, optional detail (counts) and tone. */
  | { type: 'heading'; text: string; detail?: string; tone?: CardTone }
  | { type: 'divider' }
  | { type: 'fields'; fields: { label: string; value: string }[] }
  /** `list` shows a step per line; `flow` shows short stages in a row, like a progress bar. */
  | { type: 'steps'; steps: CardStep[]; layout?: 'list' | 'flow' }
  | { type: 'list'; items: { text: string; url?: string; tone?: CardTone }[] }
  | { type: 'actions'; actions: CardAction[] }
  | { type: 'form'; form: Form }
  | { type: 'context'; text: string }

/**
 * A message from Holtkeeper, independent of where it is shown. Text is markdown-ish: `**bold**`,
 * `` `code` `` and `[label](url)` links. Cards are plain JSON, so they can be stored and sent to
 * the web panel as they are.
 */
export interface Card {
  /** Heading; short acknowledgements go without one. */
  title?: string
  /** One line under the title: what the card is about, e.g. the repository and version. */
  subtitle?: string
  tone?: CardTone
  /** Where to read more, e.g. the page of the repository in the panel. */
  url?: string
  blocks: CardBlock[]
}

/** A card with only a text block; an empty title leaves the heading out. */
export const textCard = (title: string, text: string, tone?: CardTone): Card => ({
  ...(title && { title }),
  ...(tone && { tone }),
  blocks: [{ type: 'text', text }],
})

const quote = (value: string) =>
  value === '' || /[\s"']/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value

/**
 * The command line a submitted form runs: `form.command` and `name=value` for every field with a
 * value. Toggles add `name=true` or `name=false`; multiple selects join their values with commas.
 */
export function formCommand(
  form: Form,
  values: Record<string, string | string[] | boolean | undefined>,
): string {
  const parts = [form.command]
  for (const field of form.fields) {
    const value = values[field.name]
    if (value === undefined) continue
    if (Array.isArray(value) && value.length === 0) continue
    if (value === '') continue
    const text = Array.isArray(value) ? value.join(',') : String(value)
    parts.push(`${field.name}=${quote(text)}`)
  }
  return parts.join(' ')
}
