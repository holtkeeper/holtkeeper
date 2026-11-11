import type {
  Family,
  FamilyStore,
  GuideRevision,
  GuideSection,
  GuideStore,
} from '@holtkeeper/store'
import { assertNoFamilyConflict, matchesGuideFilter, nextGuideSection } from '@holtkeeper/store'

import type { Db } from './tables.ts'

/** The SQL `GuideStore`: one JSON row per scope and section in `guides`, revisions in `guide_history`. */
export function postgresGuides(db: () => Promise<Db>, schema: string): GuideStore {
  return {
    async get(scope, section) {
      const { sql, t } = await db()
      const [row]: { data: GuideSection }[] = await sql`
        SELECT data FROM ${t.guides} WHERE scope = ${scope} AND section = ${section}`
      return row?.data
    },
    async list(filter) {
      const { sql, t } = await db()
      const rows: { data: GuideSection }[] = await sql`
        SELECT data FROM ${t.guides} ORDER BY scope COLLATE "C", section COLLATE "C"`
      return rows.map((row) => row.data).filter((row) => matchesGuideFilter(row, filter))
    },
    async put(input) {
      const { sql, t } = await db()
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`holtkeeper.guides:${schema}:${input.scope}:${input.section}`}, 0))`
        const [row]: { data: GuideSection }[] = await tx`
          SELECT data FROM ${t.guides} WHERE scope = ${input.scope} AND section = ${input.section}`
        const { stored, revision } = nextGuideSection(input, row?.data)
        if (revision)
          await tx`
            INSERT INTO ${t.guideHistory} (scope, section, version, data)
            VALUES (${input.scope}, ${input.section}, ${revision.version}, ${tx.json(revision)})`
        await tx`
          INSERT INTO ${t.guides} (scope, section, data)
          VALUES (${input.scope}, ${input.section}, ${tx.json(stored)})
          ON CONFLICT (scope, section) DO UPDATE SET data = excluded.data`
        return stored
      })
    },
    async history(scope, section) {
      const { sql, t } = await db()
      const rows: { data: GuideRevision }[] = await sql`
        SELECT data FROM ${t.guideHistory} WHERE scope = ${scope} AND section = ${section}
        ORDER BY version DESC`
      return rows.map((row) => row.data)
    },
    async removeScope(scope) {
      const { sql, t } = await db()
      await sql.begin(async (tx) => {
        await tx`DELETE FROM ${t.guides} WHERE scope = ${scope}`
        await tx`DELETE FROM ${t.guideHistory} WHERE scope = ${scope}`
      })
    },
  }
}

/** The SQL `FamilyStore`: one JSON row per family in `families`; writes serialize on a lock. */
export function postgresFamilies(db: () => Promise<Db>, schema: string): FamilyStore {
  return {
    async list() {
      const { sql, t } = await db()
      const rows: { data: Family }[] = await sql`
        SELECT data FROM ${t.families} ORDER BY name COLLATE "C", id COLLATE "C"`
      return rows.map((row) => row.data)
    },
    async get(id) {
      const { sql, t } = await db()
      const [row]: { data: Family }[] = await sql`SELECT data FROM ${t.families} WHERE id = ${id}`
      return row?.data
    },
    async put(family) {
      const { sql, t } = await db()
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`holtkeeper.families:${schema}`}, 0))`
        const rows: { data: Family }[] = await tx`SELECT data FROM ${t.families}`
        assertNoFamilyConflict(
          family,
          rows.map((row) => row.data),
        )
        const stored = { ...family, members: family.members.toSorted() }
        await tx`
          INSERT INTO ${t.families} (id, name, data) VALUES (${stored.id}, ${stored.name}, ${tx.json(stored)})
          ON CONFLICT (id) DO UPDATE SET name = excluded.name, data = excluded.data`
      })
    },
    async remove(id) {
      const { sql, t } = await db()
      await sql`DELETE FROM ${t.families} WHERE id = ${id}`
    },
  }
}
