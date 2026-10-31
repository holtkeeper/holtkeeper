import { type AnalyzerPreset, defineAnalyzer } from '@holtkeeper/analyzer'
import { z } from 'zod'

import { analyzeTestIds, defaultAttributes } from './analyze.ts'
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
  /** Test attribute names, compared case-insensitively; each also covers names extending it with `-`. */
  attributes: list(defaultAttributes),
  /** Template sources to read, by name: `jsx`, `vue`, `svelte`, `html`. */
  sources: list(Object.keys(builtinSources)),
  /** Glob patterns of files to leave out. */
  exclude: list([]),
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
 * The `testids` analyzer: lists the test attributes (`data-test-id`, `data-test-state`, ...) a
 * checkout's JSX, Vue, Svelte and HTML templates expose, per component.
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
      description:
        'comma-separated test attributes and prefixes (default data-testid,data-test,...)',
    },
    { flag: 'sources', option: 'sources', description: 'comma-separated: jsx,vue,svelte,html' },
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
      exclude: options.exclude,
      ...(signal ? { signal } : {}),
    })
    return { data, ...(ref ? { ref } : {}) }
  },
})
