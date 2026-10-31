import { expect, test } from 'bun:test'

import { libraryTsQuery } from './libraries.ts'

test('libraryTsQuery turns words into prefix operands and phrases into phrase operands', () => {
  expect(libraryTsQuery(`it's "cannot read property" a|b`)).toBe(
    `'it':* | 's':* | ('cannot' <-> 'read' <-> 'property') | 'a':* | 'b':*`,
  )
  expect(libraryTsQuery('  "" ')).toBeUndefined()
})
