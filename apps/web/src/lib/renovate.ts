import { plural } from './format.ts'

/** The `analyzers.renovate` value as the editor holds it: only options the entry sets. */
export type RenovateValue = Record<string, unknown>

/** What the editor reads of one option's JSON Schema. */
export interface RenovateField {
  title: string
  description?: string
  default: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Title, description and default of every option, from the setting's JSON Schema. */
export function renovateFields(schema: unknown): Record<string, RenovateField> {
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {}
  return Object.fromEntries(
    Object.entries(properties).flatMap(([key, property]) =>
      isRecord(property)
        ? [
            [
              key,
              {
                title: typeof property.title === 'string' ? property.title : key,
                ...(typeof property.description === 'string' && {
                  description: property.description,
                }),
                default: property.default,
              },
            ],
          ]
        : [],
    ),
  )
}

/** The stored value as an object of set options; anything else starts empty. */
export const normalizeRenovateValue = (initial: unknown): RenovateValue =>
  isRecord(initial) ? { ...initial } : {}

/** The value of `key`: what the entry sets, else the option's default. */
const effective = (
  value: RenovateValue,
  fields: Record<string, RenovateField>,
  key: string,
): unknown => value[key] ?? fields[key]?.default

/** Typed reads of effective values; a value of another type reads as `fallback`. */
export function reader(value: RenovateValue, fields: Record<string, RenovateField>) {
  const read = (key: string) => effective(value, fields, key)
  return {
    text: (key: string, fallback: string) => {
      const found = read(key)
      return typeof found === 'string' ? found : fallback
    },
    number: (key: string, fallback: number) => {
      const found = read(key)
      return typeof found === 'number' ? found : fallback
    },
    flag: (key: string, fallback: boolean) => {
      const found = read(key)
      return typeof found === 'boolean' ? found : fallback
    },
    list: (key: string, fallback: string[]) => {
      const found = read(key)
      return Array.isArray(found) && found.every((item) => typeof item === 'string')
        ? found
        : fallback
    },
  }
}

const groupingText: Record<string, string> = {
  separate: 'one merge request per dependency',
  'non-major': 'minor and patch updates in one merge request',
  all: 'every update in one merge request',
}

/**
 * What the options make Renovate do, in two or three plain sentences, for the editor's summary.
 */
export function renovateSummary(
  value: RenovateValue,
  fields: Record<string, RenovateField>,
): string {
  const get = reader(value, fields)
  const limit = get.number('concurrentLimit', 10)
  const limitText = limit > 0 ? `at most ${limit} open at a time` : 'with no limit on open ones'
  const mode = get.text('mode', 'report')
  if (get.text('updates', 'all') === 'security')
    return mode === 'report'
      ? 'Renovate looks up updates that fix a known vulnerability; Holtkeeper reports them and pushes nothing.'
      : `Renovate opens merge requests only for updates that fix a known vulnerability, right away: one per fix, ${limitText}.`
  const what = get.flag('majors', true)
    ? 'every update, majors included'
    : 'minor and patch updates'
  const age = get.number('releaseAgeDays', 3)
  const ageText =
    age > 0 ? `once a release is ${plural(age, 'day')} old` : 'as soon as they are released'
  if (mode === 'report')
    return `Renovate looks up ${what}; Holtkeeper reports them and pushes nothing. An update counts ${ageText}.`
  return `Renovate opens merge requests for ${what}, ${ageText}: ${
    groupingText[get.text('grouping', 'separate')] ?? ''
  }, ${limitText}.${get.flag('lockFileMaintenance', false) ? ' Lockfiles are refreshed weekly.' : ''}`
}

/** Presets the presets field suggests. */
export const presetSuggestions = [
  'config:recommended',
  'config:best-practices',
  ':semanticCommits',
  ':automergeMinor',
  'helpers:pinGitHubActionDigests',
  'docker:pinDigests',
]
