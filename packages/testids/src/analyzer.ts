import { type AnalyzerPreset, defineAnalyzer } from '@holtkeeper/analyzer'
import { z } from 'zod'

import {
  analyzeTestIds,
  defaultAttributes,
  defaultEvents,
  defaultFactories,
  defaultMarkers,
  defaultRoles,
  defaultTags,
} from './analyze.ts'
import type { TestIdsData } from './model.ts'
import { testIdsAnalysis } from './report.ts'
import { builtinSources } from './sources.ts'

/** A list option that also accepts a comma-separated string, as flags pass it. */
const list = (fallback: readonly string[]) =>
  z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : value,
    z.array(z.string().min(1)).default([...fallback]),
  )

/** Options of the `testids` analyzer. */
export const testIdsOptionsSchema = z.object({
  /** Attribute or prop names that count as a test id, compared case-insensitively. */
  attributes: list(defaultAttributes),
  /** Template sources to read, by name: `jsx`, `vue`, `svelte`, `html`. */
  sources: list(Object.keys(builtinSources)),
  /** Component name (or `*` pattern) → native tag it renders, e.g. `{ "Button": "button" }`. */
  components: z.record(z.string(), z.string()).default({}),
  /** Factories whose results are styled native tags (`styled.button`, `tw.a`, `chakra.input`). */
  factories: list(defaultFactories),
  /** Import prefix → folder, on top of the root `tsconfig.json` paths, e.g. `{ "@/": "src/" }`. */
  aliases: z.record(z.string(), z.string()).default({}),
  /** Tag or component names (`*` patterns) never reported. */
  ignore: list([]),
  /** Glob patterns of files to leave out. */
  exclude: list([]),
  /** Native tags that are interactive by themselves. */
  tags: list(defaultTags),
  /** Events whose handlers make an element interactive, lower-case without `on`. */
  events: list(defaultEvents),
  /** ARIA roles that make an element interactive. */
  roles: list(defaultRoles),
  /** Attributes that make a component interactive: `href`, `to`, `v-model`, ... */
  markers: list(defaultMarkers),
})

export type TestIdsOptions = z.output<typeof testIdsOptionsSchema>

/** Test id conventions of common end-to-end setups; each sets `attributes`. */
export const testIdPresets: AnalyzerPreset<TestIdsOptions>[] = [
  {
    id: 'testing-library',
    label: 'Testing Library / Playwright',
    description: 'Only `data-testid`, the attribute `getByTestId` reads by default.',
    options: { attributes: ['data-testid'] },
  },
  {
    id: 'cypress',
    label: 'Cypress',
    description:
      'The attributes the Cypress best practices recommend: `data-cy`, `data-test`, `data-testid`.',
    options: { attributes: ['data-cy', 'data-test', 'data-testid'] },
  },
  {
    id: 'react-native',
    label: 'React Native',
    description: 'The `testID` prop that Detox, Appium and React Native Testing Library read.',
    options: { attributes: ['testID'] },
  },
]

/**
 * The `testids` analyzer: finds interactive elements in a checkout's JSX, Vue, Svelte and HTML
 * templates, following styled components to their native tags, and records which carry a test id.
 */
export const testIdsAnalyzer = defineAnalyzer<TestIdsData, TestIdsOptions>({
  kind: 'testids',
  analysis: testIdsAnalysis,
  scope: 'repo',
  needs: { checkout: true },
  options: testIdsOptionsSchema,
  flags: [
    {
      flag: 'attributes',
      option: 'attributes',
      description: 'comma-separated test id attributes (default data-testid,data-test,data-qa,...)',
    },
    { flag: 'sources', option: 'sources', description: 'comma-separated: jsx,vue,svelte,html' },
    { flag: 'ignore', option: 'ignore', description: 'comma-separated component names to skip' },
    { flag: 'exclude', option: 'exclude', description: 'comma-separated globs of files to skip' },
  ],
  presets: testIdPresets,
  async run({ dir, ref, options, signal }) {
    if (!dir) throw new Error('the testids analyzer needs a checkout')
    const sources = options.sources.flatMap((name) => {
      const source = builtinSources[name]
      if (!source) throw new Error(`unknown template source ${name}`)
      return [source]
    })
    const data = await analyzeTestIds({
      dir,
      sources,
      attributes: options.attributes,
      components: options.components,
      factories: options.factories,
      aliases: options.aliases,
      ignore: options.ignore,
      exclude: options.exclude,
      tags: options.tags,
      events: options.events,
      roles: options.roles,
      markers: options.markers,
      ...(signal ? { signal } : {}),
    })
    return { data, ...(ref ? { ref } : {}) }
  },
})
