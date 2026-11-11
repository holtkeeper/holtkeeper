import type { Database } from 'bun:sqlite'

import type { AgentTask, AgentTaskGroup, AgentTaskStore } from '@holtkeeper/store'
import {
  byTaskUpdate,
  limited,
  matchesAgentGroupFilter,
  matchesAgentTaskFilter,
} from '@holtkeeper/store'

interface DataRow {
  data: string
}

const toTask = (row: DataRow): AgentTask => JSON.parse(row.data)
const toGroup = (row: DataRow): AgentTaskGroup => JSON.parse(row.data)

/** The SQLite `AgentTaskStore`: one JSON row per task in `agent_tasks`, per group in `agent_task_groups`. */
export function sqliteTasks(db: Database): AgentTaskStore {
  const sql = {
    get: db.query<DataRow, [string]>('SELECT data FROM agent_tasks WHERE id = ?'),
    all: db.query<DataRow, []>('SELECT data FROM agent_tasks'),
    ofGroup: db.query<DataRow, [string]>('SELECT data FROM agent_tasks WHERE group_id = ?'),
    upsert: db.prepare(
      `INSERT INTO agent_tasks (id, group_id, repo, status, updated_at, data)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET group_id = excluded.group_id, repo = excluded.repo,
         status = excluded.status, updated_at = excluded.updated_at, data = excluded.data`,
    ),
    transition: db.prepare(
      `UPDATE agent_tasks SET group_id = ?, repo = ?, status = ?, updated_at = ?, data = ?
       WHERE id = ? AND status IN (SELECT value FROM json_each(?))`,
    ),
    getGroup: db.query<DataRow, [string]>('SELECT data FROM agent_task_groups WHERE id = ?'),
    allGroups: db.query<DataRow, []>('SELECT data FROM agent_task_groups'),
    upsertGroup: db.prepare(
      `INSERT INTO agent_task_groups (id, updated_at, data) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data`,
    ),
  }
  return {
    async get(id) {
      const row = sql.get.get(id)
      return row ? toTask(row) : undefined
    },
    async list(filter) {
      const rows =
        filter?.groupIds?.length === 1 ? sql.ofGroup.all(filter.groupIds[0]!) : sql.all.all()
      return limited(
        rows
          .map(toTask)
          .filter((task) => matchesAgentTaskFilter(task, filter))
          .toSorted(byTaskUpdate),
        filter?.limit,
      )
    },
    async put(task) {
      sql.upsert.run(
        task.id,
        task.groupId,
        task.repo,
        task.status,
        task.updatedAt,
        JSON.stringify(task),
      )
    },
    async transition(task, from) {
      const result = sql.transition.run(
        task.groupId,
        task.repo,
        task.status,
        task.updatedAt,
        JSON.stringify(task),
        task.id,
        JSON.stringify(from),
      )
      return result.changes > 0
    },
    async getGroup(id) {
      const row = sql.getGroup.get(id)
      return row ? toGroup(row) : undefined
    },
    listGroups: async (filter) =>
      limited(
        sql.allGroups
          .all()
          .map(toGroup)
          .filter((group) => matchesAgentGroupFilter(group, filter))
          .toSorted(byTaskUpdate),
        filter?.limit,
      ),
    async putGroup(group) {
      sql.upsertGroup.run(group.id, group.updatedAt, JSON.stringify(group))
    },
  }
}
