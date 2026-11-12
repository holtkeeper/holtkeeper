import type { McpPersonUsage } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { Plug } from 'lucide-react'

import { useMcpUsage } from '../../api/queries.ts'
import { formatCount, formatRelative } from '../../lib/format.ts'
import { errorRate, sparkHeights } from '../../lib/mcp-usage.ts'
import { formatGroupMatch } from '../../lib/scope.ts'
import { Avatar, EmptyState, ErrorState, Placeholder, Table, Tag, Td, Th } from '../../ui/index.ts'

const days = 7

function Spark({ person }: { person: McpPersonUsage }) {
  return (
    <span
      role="img"
      aria-label={`Tool calls per day: ${person.daily.join(', ')}`}
      className="flex h-5 w-[70px] items-end gap-[2px]"
    >
      {sparkHeights(person.daily).map((height, index) => (
        <i
          key={index}
          className="block min-w-0 flex-1 rounded-t-[1px]"
          style={{
            height: height ? `${height}%` : '1px',
            background: height ? 'color-mix(in oklab, var(--fg) 62%, transparent)' : 'var(--line)',
          }}
        />
      ))}
    </span>
  )
}

/**
 * Ops › AI spend › MCP usage by person: tool calls over the last 7 days per person with their
 * teams, live tokens, a daily sparkline, the two most used tools, the error rate and the last
 * call. The server lists everyone for viewers with global `users:read`, else only the viewer.
 */
export function McpPeople() {
  const usage = useMcpUsage(days)
  return (
    <section aria-labelledby="mcp-people" className="flex flex-col">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line px-4 py-3">
        <h2 id="mcp-people" className="text-[13px] font-semibold">
          MCP usage by person
        </h2>
        <span className="text-xs text-muted">
          agents connected with personal tokens · last {days} days
        </span>
        <span className="ms-auto text-xs text-muted">Tool calls do not call a model.</span>
        <Link
          to="/account/$section"
          params={{ section: 'agents' }}
          className="text-xs text-muted underline-offset-2 hover:text-foreground hover:underline"
        >
          Your tokens
        </Link>
      </header>
      {usage.isPending ? (
        <Placeholder className="mx-4 mb-4 h-32" />
      ) : usage.isError ? (
        <div className="px-4 pb-4">
          <ErrorState error={usage.error} />
        </div>
      ) : usage.data.people.length ? (
        <Table label="MCP usage by person">
          <thead>
            <tr>
              <Th>Person</Th>
              <Th>Team</Th>
              <Th align="right">Active tokens</Th>
              <Th align="right">Tool calls</Th>
              <Th>Last {days} days</Th>
              <Th>Most used tools</Th>
              <Th align="right">Errors</Th>
              <Th>Last call</Th>
            </tr>
          </thead>
          <tbody>
            {usage.data.people.map((person) => (
              <tr key={person.id}>
                <Td>
                  <span className="flex items-center gap-2">
                    <Avatar
                      src={`/api/avatars/${encodeURIComponent(person.id)}.svg`}
                      name={person.name}
                      size="xs"
                    />
                    {person.name}
                  </span>
                </Td>
                <Td>
                  {person.teams.length ? (
                    <span className="flex flex-wrap gap-1">
                      {person.teams.map((team) => (
                        <Tag key={formatGroupMatch(team)}>{formatGroupMatch(team)}</Tag>
                      ))}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Td>
                <Td align="right" className="mono">
                  {person.activeTokens}
                </Td>
                <Td align="right" className="mono">
                  {formatCount(person.calls)}
                </Td>
                <Td>
                  <Spark person={person} />
                </Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    {person.tools.slice(0, 2).map((tool) => (
                      <Tag key={tool.tool} mono>
                        {tool.tool}
                      </Tag>
                    ))}
                  </span>
                </Td>
                <Td align="right" className="mono text-muted">
                  {errorRate(person.calls, person.errors)}
                </Td>
                <Td className="text-muted">
                  {person.lastAt ? formatRelative(person.lastAt) : '—'}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState
          icon={<Plug />}
          title="No MCP calls"
          description={`Nobody you can see called the MCP endpoint in the last ${days} days.`}
        />
      )}
    </section>
  )
}
