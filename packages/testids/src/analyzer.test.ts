import { expect, test } from 'bun:test'

import { testIdsAnalyzer } from './analyzer.ts'

test('runs in every repository, also those without a root package.json', () => {
  expect(testIdsAnalyzer.appliesTo).toBeUndefined()
})
