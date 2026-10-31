import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { libraryFtsQuery } from './libraries.ts'
import { migrate, migrations } from './migrations.ts'

describe('libraryFtsQuery', () => {
  test('quotes words as prefix terms and phrases as phrases', () => {
    expect(libraryFtsQuery('use "cannot read" NEAR(x)')).toBe(
      '"use"* OR "cannot read" OR "near"* OR "x"*',
    )
    expect(libraryFtsQuery(' "*()" ')).toBeUndefined()
  })
})

test('v11 adds library tables to a v10 database', () => {
  const db = new Database(':memory:')
  migrate(
    db,
    migrations.filter((m) => m.version <= 10),
  )
  migrate(db)
  for (const table of [
    'libraries',
    'library_versions',
    'library_chunks',
    'library_chunk_versions',
    'library_issues',
  ])
    expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([])
  db.close()
})
