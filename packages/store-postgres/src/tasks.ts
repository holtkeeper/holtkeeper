import type { AgentTask, AgentTaskGroup, AgentTaskStore } from '@holtkeeper/store'
import { limited, matchesAgentGroupFilter, matchesAgentTaskFilter } from '@holtkeeper/store'

import type { Db } from './tables.ts'

/** The SQL `AgentTaskStore`: one JSON row per task in `agent_tasks`, per group in `agent_task_groups`. */
export function postgresTasks(db: () => Promise<Db>): AgentTaskStore {
  return {
    async get(id) {
      const { sql, t } = await db()
      const [row]: { data: AgentTask }[] = await sql`
        SELECT data FROM ${t.agentTasks} WHERE id = ${id}`
      return row?.data
    },
    async list(filter) {
      const { sql, t } = await db()
      const groupIds = filter?.groupIds
      const rows: { data: AgentTask }[] = groupIds
        ? await sql`
            SELECT data FROM ${t.agentTasks}
            WHERE group_id = ANY(${sql.array([...groupIds], 'TEXT')})
            ORDER BY updated_at COLLATE "C" DESC, id COLLATE "C"`
        : await sql`
            SELECT data FROM ${t.agentTasks}
            ORDER BY updated_at COLLATE "C" DESC, id COLLATE "C"`
      return limited(
        rows.map((row) => row.data).filter((task) => matchesAgentTaskFilter(task, filter)),
        filter?.limit,
      )
    },
    async put(task) {
      const { sql, t } = await db()
      await sql`
        INSERT INTO ${t.agentTasks} (id, group_id, repo, status, updated_at, data)
        VALUES (${task.id}, ${task.groupId}, ${task.repo}, ${task.status}, ${task.updatedAt},
          ${sql.json(task)})
        ON CONFLICT (id) DO UPDATE SET group_id = excluded.group_id, repo = excluded.repo,
          status = excluded.status, updated_at = excluded.updated_at, data = excluded.data`
    },
    async transition(task, from) {
      const { sql, t } = await db()
      const rows = await sql`
        UPDATE ${t.agentTasks} SET group_id = ${task.groupId}, repo = ${task.repo},
          status = ${task.status}, updated_at = ${task.updatedAt}, data = ${sql.json(task)}
        WHERE id = ${task.id} AND status = ANY(${sql.array([...from], 'TEXT')})
        RETURNING id`
      return rows.length > 0
    },
    async getGroup(id) {
      const { sql, t } = await db()
      const [row]: { data: AgentTaskGroup }[] = await sql`
        SELECT data FROM ${t.agentTaskGroups} WHERE id = ${id}`
      return row?.data
    },
    async listGroups(filter) {
      const { sql, t } = await db()
      const rows: { data: AgentTaskGroup }[] = await sql`
        SELECT data FROM ${t.agentTaskGroups}
        ORDER BY updated_at COLLATE "C" DESC, id COLLATE "C"`
      return limited(
        rows.map((row) => row.data).filter((group) => matchesAgentGroupFilter(group, filter)),
        filter?.limit,
      )
    },
    async putGroup(group) {
      const { sql, t } = await db()
      await sql`
        INSERT INTO ${t.agentTaskGroups} (id, updated_at, data)
        VALUES (${group.id}, ${group.updatedAt}, ${sql.json(group)})
        ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data`
    },
  }
}
