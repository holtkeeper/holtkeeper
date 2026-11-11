import type { Database } from 'bun:sqlite'

import type {
  Family,
  FamilyStore,
  GuideRevision,
  GuideSection,
  GuideSectionInput,
  GuideStore,
} from '@holtkeeper/store'
import { assertNoFamilyConflict, matchesGuideFilter, nextGuideSection } from '@holtkeeper/store'

interface DataRow {
  data: string
}

const toSection = (row: DataRow): GuideSection => JSON.parse(row.data)
const toRevision = (row: DataRow): GuideRevision => JSON.parse(row.data)
const toFamily = (row: DataRow): Family => JSON.parse(row.data)

/** The SQLite `GuideStore`: one JSON row per scope and section in `guides`, revisions in `guide_history`. */
export function sqliteGuides(db: Database): GuideStore {
  const sql = {
    get: db.query<DataRow, [string, string]>(
      'SELECT data FROM guides WHERE scope = ? AND section = ?',
    ),
    all: db.query<DataRow, []>('SELECT data FROM guides ORDER BY scope, section'),
    upsert: db.prepare(
      `INSERT INTO guides (scope, section, data) VALUES (?, ?, ?)
       ON CONFLICT (scope, section) DO UPDATE SET data = excluded.data`,
    ),
    addRevision: db.prepare(
      'INSERT INTO guide_history (scope, section, version, data) VALUES (?, ?, ?, ?)',
    ),
    history: db.query<DataRow, [string, string]>(
      'SELECT data FROM guide_history WHERE scope = ? AND section = ? ORDER BY version DESC',
    ),
    removeScope: db.prepare('DELETE FROM guides WHERE scope = ?'),
    removeHistory: db.prepare('DELETE FROM guide_history WHERE scope = ?'),
  }
  const read = (row: DataRow | null): GuideSection | undefined => (row ? toSection(row) : undefined)

  const put = db.transaction((input: GuideSectionInput): GuideSection => {
    const previous = read(sql.get.get(input.scope, input.section))
    const { stored, revision } = nextGuideSection(input, previous)
    if (revision)
      sql.addRevision.run(input.scope, input.section, revision.version, JSON.stringify(revision))
    sql.upsert.run(input.scope, input.section, JSON.stringify(stored))
    return stored
  })
  const removeScope = db.transaction((scope: string) => {
    sql.removeScope.run(scope)
    sql.removeHistory.run(scope)
  })

  return {
    get: async (scope, section) => read(sql.get.get(scope, section)),
    list: async (filter) =>
      sql.all
        .all()
        .map(toSection)
        .filter((row) => matchesGuideFilter(row, filter)),
    put: async (input) => put.immediate(input),
    history: async (scope, section) => sql.history.all(scope, section).map(toRevision),
    async removeScope(scope) {
      removeScope.immediate(scope)
    },
  }
}

/** The SQLite `FamilyStore`: one JSON row per family in `families`. */
export function sqliteFamilies(db: Database): FamilyStore {
  const sql = {
    all: db.query<DataRow, []>('SELECT data FROM families ORDER BY name, id'),
    get: db.query<DataRow, [string]>('SELECT data FROM families WHERE id = ?'),
    upsert: db.prepare(
      `INSERT INTO families (id, name, data) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, data = excluded.data`,
    ),
    remove: db.prepare('DELETE FROM families WHERE id = ?'),
  }
  const list = () => sql.all.all().map(toFamily)
  const put = db.transaction((family: Family) => {
    assertNoFamilyConflict(family, list())
    const stored = { ...family, members: family.members.toSorted() }
    sql.upsert.run(stored.id, stored.name, JSON.stringify(stored))
  })
  return {
    list: async () => list(),
    async get(id) {
      const row = sql.get.get(id)
      return row ? toFamily(row) : undefined
    },
    async put(family) {
      put.immediate(family)
    },
    async remove(id) {
      sql.remove.run(id)
    },
  }
}
