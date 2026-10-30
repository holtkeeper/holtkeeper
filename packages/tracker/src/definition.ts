import { z } from 'zod'

import { normalizeStepSchema } from './normalize.ts'
import { outputSchema } from './outputs/index.ts'
import { ruleSchema } from './rules/index.ts'
import { sourceSchema } from './sources/index.ts'

const duplicate = (ids: string[]) => ids.find((id, index) => ids.indexOf(id) !== index)

/**
 * A tracker: what entities are (`entity`), where they appear (`sources`), what is wrong with
 * them (`rules`) and where the overview goes (`outputs`). Ids of sources, rules and outputs
 * default to `<kind>-<n>` (sources, outputs) and the kind (rules) and must be unique.
 */
export const trackerDefinitionSchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'letters, digits, dots, dashes and underscores'),
    name: z.string().min(1),
    entity: z
      .object({
        /** What one entity is called, e.g. `Feature flag`. */
        label: z.string().min(1).default('Entity'),
        key: z
          .object({ normalize: z.array(normalizeStepSchema).default([]) })
          .default({ normalize: [] }),
      })
      .default({ label: 'Entity', key: { normalize: [] } }),
    sources: z.array(sourceSchema).min(1),
    rules: z.array(ruleSchema).default([]),
    outputs: z.array(outputSchema).default([]),
  })
  .superRefine((definition, context) => {
    const checks: [string, string[]][] = [
      [
        'sources',
        definition.sources.map((source, index) => source.id ?? `${source.kind}-${index + 1}`),
      ],
      ['rules', definition.rules.map((rule) => rule.id ?? rule.kind)],
      [
        'outputs',
        definition.outputs.map((output, index) => output.id ?? `${output.kind}-${index + 1}`),
      ],
    ]
    for (const [path, ids] of checks) {
      const repeated = duplicate(ids)
      if (repeated)
        context.addIssue({
          code: 'custom',
          path: [path],
          message: `duplicate id ${repeated}; set distinct ids`,
        })
    }
  })

/** A validated tracker definition, defaults applied. */
export type TrackerDefinition = z.output<typeof trackerDefinitionSchema>

/** A tracker definition as written in config or settings, before defaults. */
export type TrackerDefinitionInput = z.input<typeof trackerDefinitionSchema>

/** Validates the `trackers` setting and config entry: definitions with unique ids. */
export const trackersSchema = z.array(trackerDefinitionSchema).superRefine((trackers, context) => {
  const repeated = duplicate(trackers.map((tracker) => tracker.id))
  if (repeated) context.addIssue({ code: 'custom', message: `duplicate tracker id ${repeated}` })
})

/**
 * The scoped `trackers` setting, shaped like `SettingDefinition` from `@holtkeeper/settings` so
 * the settings registry can list it without this package depending on it.
 */
export const trackersSetting = {
  key: 'trackers',
  label: 'Trackers',
  description:
    'Declarative trackers of entities such as feature flags across repositories and documents: sources, rules and outputs. The tracker analyzer runs one of them by id.',
  section: 'Tracking',
  help: `A tracker finds one kind of entity, such as feature flags, everywhere it appears and reports what is wrong with it.

- **Sources** say where entities appear (code, configs, documents); **rules** decide what is a problem (unused, expired, missing an owner); **outputs** say where the overview goes.
- Give sources and outputs explicit ids when a tracker has several of the same kind, so rules and history stay stable.
- Start with one source and one output, check the first run, then add rules.`,
  schema: trackersSchema,
  form: trackersSchema.meta({ 'x-editor': 'trackers' }),
}

/** Id of the source at `index`. */
export const sourceId = (source: { id?: string | undefined; kind: string }, index: number) =>
  source.id ?? `${source.kind}-${index + 1}`

/** Id of the output at `index`. */
export const outputId = (output: { id?: string | undefined; kind: string }, index: number) =>
  output.id ?? `${output.kind}-${index + 1}`
