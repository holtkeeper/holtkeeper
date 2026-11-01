import type { McpUsageOverview } from '@holtkeeper/api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Bot, KeyRound, Plus, Trash2, Wrench } from 'lucide-react'
import { useDeferredValue, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { messageOf } from '../../api/client.ts'
import {
  useCreateMcpToken,
  useMcpTokens,
  useMcpTools,
  useMcpUsage,
  useRevokeMcpToken,
} from '../../api/queries.ts'
import { formatDate, formatRelative } from '../../lib/format.ts'
import { type McpTool, groupTools, mcpSetup, tokenLifetimes, toolParams } from '../../lib/mcp.ts'
import {
  Button,
  Chip,
  ConfirmDialog,
  CopyField,
  Dialog,
  EmptyState,
  ErrorState,
  Notice,
  Page,
  Panel,
  Placeholder,
  SearchInput,
  Segmented,
  StatCard,
  Table,
  Tabs,
  Td,
  TextField,
  Th,
  notify,
} from '../../ui/index.ts'

const tabs = new Set(['connect', 'tools', 'usage'])

/** Where the endpoint lives as the server sees it, falling back to this origin. */
const useEndpoint = () => useMcpUsage(30).data?.endpoint ?? `${window.location.origin}/mcp`

/** The MCP endpoint for agents: connecting a client, personal tokens, the tools and their use. */
export function McpPage() {
  const search: { tab?: string } = useSearch({ strict: false })
  const navigate = useNavigate()
  const tab = search.tab && tabs.has(search.tab) ? search.tab : 'connect'
  return (
    <Page
      title="MCP server"
      icon="api"
      description="Give AI agents read-only access to your packages and the libraries you use"
    >
      <Tabs
        aria-label="MCP views"
        selected={tab}
        onSelect={(next) =>
          void navigate({ to: '/mcp-server', search: next === 'connect' ? {} : { tab: next } })
        }
        items={[
          { id: 'connect', label: 'Connect', content: <ConnectTab /> },
          { id: 'tools', label: 'Tools', content: <ToolsTab /> },
          { id: 'usage', label: 'Usage', content: <UsageTab /> },
        ]}
      />
    </Page>
  )
}

function Code({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto rounded-xl border border-border bg-default px-3 py-2 font-mono text-[12.5px] leading-relaxed">
      {code}
    </pre>
  )
}

const steps = [
  [
    'Create a token',
    'One per machine or agent, so you can revoke it alone. It acts as you, read-only.',
  ],
  [
    'Add the server to your client',
    'Claude Code, Cursor or any client that speaks Streamable HTTP.',
  ],
  [
    'Ask about your code',
    'Agents look up exports, usages and upgrade impact of your packages, and version-exact docs, changes and issues of third-party libraries.',
  ],
] as const

function ConnectTab() {
  const endpoint = useEndpoint()
  return (
    <div className="flex flex-col gap-4">
      <ol className="grid gap-3 sm:grid-cols-3">
        {steps.map(([title, text], index) => (
          <li
            key={title}
            className="flex gap-3 rounded-2xl border border-border bg-surface px-4 py-3 shadow-surface"
          >
            <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
              {index + 1}
            </span>
            <span className="flex flex-col gap-0.5 text-sm">
              <span className="font-medium">{title}</span>
              <span className="text-muted">{text}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="grid gap-4 lg:grid-cols-2">
        <TokensPanel endpoint={endpoint} />
        <ConnectPanel endpoint={endpoint} />
      </div>
    </div>
  )
}

function ToolsTab() {
  const tools = useMcpTools()
  const [query, setQuery] = useState('')
  const needle = useDeferredValue(query).trim().toLowerCase()
  const matches = (tool: McpTool) =>
    !needle ||
    tool.name.toLowerCase().includes(needle) ||
    (tool.description ?? '').toLowerCase().includes(needle)
  if (tools.isPending) return <Placeholder className="h-96" />
  if (tools.isError) return <ErrorState error={tools.error} />
  const groups = groupTools(tools.data.filter(matches))
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {tools.data.length} tools, answering only about repositories you can read; all of them
          only read, except that agents can propose knowledge entries for review. Agents pick them
          on their own; name a package, symbol or error and they call the right ones.
        </p>
        <SearchInput
          aria-label="Filter tools"
          placeholder="Tool name or description"
          value={query}
          onChange={setQuery}
          className="w-72"
        />
      </div>
      {groups.length ? (
        groups.map((group) => (
          <Panel key={group.id} title={group.label} description={group.description}>
            <div className="flex flex-col">
              {group.tools.map((tool) => (
                <ToolCard key={tool.name} tool={tool} />
              ))}
            </div>
          </Panel>
        ))
      ) : (
        <EmptyState icon={<Wrench />} title="No tool matches" />
      )}
    </div>
  )
}

function ToolCard({ tool }: { tool: McpTool }) {
  const params = toolParams(tool)
  return (
    <div
      id={`tool-${tool.name}`}
      className="flex flex-col gap-2 border-b border-border py-4 first:pt-0 last:border-b-0 last:pb-0"
    >
      <span className="font-mono text-sm font-semibold">{tool.name}</span>
      {tool.description ? <p className="text-sm text-muted">{tool.description}</p> : null}
      {params.length ? (
        <Table label={`Arguments of ${tool.name}`}>
          <thead>
            <tr>
              <Th>Argument</Th>
              <Th>Type</Th>
              <Th>Description</Th>
            </tr>
          </thead>
          <tbody>
            {params.map((param) => (
              <tr key={param.name}>
                <Td className="whitespace-nowrap">
                  <span className="font-mono text-xs">{param.name}</span>
                  {param.required ? (
                    <Chip className="ml-2" size="sm">
                      required
                    </Chip>
                  ) : null}
                </Td>
                <Td className="font-mono text-xs text-muted">{param.type}</Td>
                <Td className="text-muted">{param.description ?? '—'}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="text-xs text-muted">No arguments.</p>
      )}
    </div>
  )
}

const usageRanges = [
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
] as const

function UsageTab() {
  const [range, setRange] = useState<(typeof usageRanges)[number]['id']>('30')
  const usage = useMcpUsage(Number(range))
  return (
    <Panel
      title="Usage"
      description="Tool calls agents made through the MCP endpoint."
      actions={
        <Segmented aria-label="Range" value={range} onChange={setRange} options={usageRanges} />
      }
    >
      {usage.isPending ? (
        <Placeholder className="h-72" />
      ) : usage.isError ? (
        <ErrorState error={usage.error} />
      ) : (
        <UsageView usage={usage.data} />
      )}
    </Panel>
  )
}

function ConnectPanel({ endpoint }: { endpoint: string }) {
  const setup = mcpSetup(endpoint)
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <Bot className="size-4" />
          Connect an agent
        </span>
      }
      description="Streamable HTTP, stateless, read-only. Replace <token> with one of your tokens."
    >
      <div className="flex flex-col gap-3 text-sm">
        <CopyField label="MCP endpoint" value={endpoint} />
        <div>
          <div className="mb-1 text-muted">Claude Code</div>
          <CopyField label="Claude Code command" value={setup.claudeCode} />
        </div>
        <div>
          <div className="mb-1 text-muted">Other clients (.mcp.json, Cursor, …)</div>
          <Code code={setup.json} />
        </div>
        <div>
          <div className="mb-1 text-muted">Check a token from the shell</div>
          <CopyField label="curl command" value={setup.curl} />
        </div>
        <p className="text-xs text-muted">
          The same token also reads the catalog over HTTP: <code>GET /api/api-surface/*</code> and{' '}
          <code>GET /api/libraries/*</code> with the same <code>Authorization</code> header.
        </p>
      </div>
    </Panel>
  )
}

function TokensPanel({ endpoint }: { endpoint: string }) {
  const tokens = useMcpTokens()
  const create = useCreateMcpToken()
  const revoke = useRevokeMcpToken()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [lifetime, setLifetime] = useState<(typeof tokenLifetimes)[number]['id']>('90')
  const [secret, setSecret] = useState<string | undefined>(undefined)
  const [revoking, setRevoking] = useState<string | undefined>(undefined)

  const close = (next: boolean) => {
    setOpen(next)
    if (!next) {
      setSecret(undefined)
      setName('')
    }
  }
  const submit = () =>
    create.mutate(
      { name: name.trim() || 'MCP client', expiresInDays: Number(lifetime) },
      {
        onSuccess: (result) => setSecret(result.secret),
        onError: (error) => notify.error('Not created', messageOf(error)),
      },
    )

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <KeyRound className="size-4" />
          Your tokens
        </span>
      }
      description="Personal access tokens for the MCP endpoint and the catalog API."
      actions={
        tokens.data?.available ? (
          <Button size="sm" variant="secondary" onPress={() => setOpen(true)}>
            <Plus className="size-3.5" />
            New token
          </Button>
        ) : null
      }
    >
      {tokens.isPending ? (
        <Placeholder className="h-32" />
      ) : tokens.isError ? (
        <ErrorState error={tokens.error} />
      ) : !tokens.data.available ? (
        <Notice title="Tokens are unavailable">
          The store keeps no key-value state; signed-in requests still reach the endpoint.
        </Notice>
      ) : tokens.data.tokens.length ? (
        <Table label="MCP tokens">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Token</Th>
              <Th>Expires</Th>
              <Th>Last used</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {tokens.data.tokens.map((token) => (
              <tr key={token.id}>
                <Td>{token.name}</Td>
                <Td className="font-mono text-xs text-muted">{token.prefix}…</Td>
                <Td className="text-muted">
                  {token.expiresAt ? formatDate(token.expiresAt) : 'never'}
                </Td>
                <Td className="text-muted">
                  {token.lastUsedAt ? formatRelative(token.lastUsedAt) : 'never'}
                </Td>
                <Td align="right">
                  <Button
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    aria-label={`Revoke ${token.name}`}
                    onPress={() => setRevoking(token.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState
          icon={<KeyRound />}
          title="No tokens yet"
          description="Create one for each machine or agent you connect."
        />
      )}
      <Dialog
        isOpen={open}
        onOpenChange={close}
        title={secret ? 'Token created' : 'New MCP token'}
        description={
          secret ? 'Copy it now; it is not shown again.' : 'Read-only access to the catalog as you.'
        }
        footer={
          secret ? (
            <Button variant="primary" onPress={() => close(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="tertiary" onPress={() => close(false)}>
                Cancel
              </Button>
              <Button variant="primary" onPress={submit} isPending={create.isPending}>
                Create
              </Button>
            </>
          )
        }
      >
        {secret ? (
          <div className="flex flex-col gap-3">
            <CopyField label="Token" value={secret} />
            <div className="text-sm text-muted">Claude Code</div>
            <CopyField label="Claude Code command" value={mcpSetup(endpoint, secret).claudeCode} />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <TextField
              label="Name"
              placeholder="Laptop, CI agent, …"
              value={name}
              onChange={setName}
              autoFocus
            />
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm">Expires after</span>
              <Segmented
                aria-label="Expires after"
                value={lifetime}
                onChange={setLifetime}
                options={tokenLifetimes}
              />
            </div>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        isOpen={revoking !== undefined}
        onOpenChange={(next) => {
          if (!next) setRevoking(undefined)
        }}
        title="Revoke this token?"
        confirmLabel="Revoke"
        isPending={revoke.isPending}
        onConfirm={() => {
          if (!revoking) return
          revoke.mutate(revoking, {
            onSuccess: () => setRevoking(undefined),
            onError: (error) => notify.error('Not revoked', messageOf(error)),
          })
        }}
      >
        Agents using it lose access right away.
      </ConfirmDialog>
    </Panel>
  )
}

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })

function UsageView({ usage }: { usage: McpUsageOverview }) {
  const points = usage.days.map((day) => ({ ...day, ok: day.calls - day.errors }))
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Tool calls" value={usage.totals.calls} />
        <StatCard
          label="Failed"
          value={usage.totals.errors}
          accent={usage.totals.errors ? 'var(--danger)' : undefined}
        />
        <StatCard label="People" value={usage.totals.people} />
        <StatCard label="Packages asked about" value={usage.packages.length} />
      </div>
      <div
        className="h-56 w-full"
        role="img"
        aria-label={`MCP calls over ${usage.days.length} days, ${usage.totals.calls} in total`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis
              dataKey="date"
              tickFormatter={dayLabel}
              tickLine={false}
              axisLine={false}
              minTickGap={32}
              tick={{ fill: 'var(--chart-axis)', fontSize: 12 }}
            />
            <YAxis
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              width={48}
              tick={{ fill: 'var(--chart-axis)', fontSize: 12 }}
            />
            <Tooltip
              cursor={{ fill: 'var(--chart-grid)' }}
              content={({ active, label }) => {
                const point = points.find((p) => p.date === label)
                if (!active || !point) return null
                return (
                  <div className="min-w-32 rounded-xl border border-border bg-overlay p-3 text-xs shadow-overlay">
                    <div className="mb-2 font-medium">{dayLabel(point.date)}</div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted">Calls</span>
                      <span className="tabular">{point.calls}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted">Failed</span>
                      <span className="tabular">{point.errors}</span>
                    </div>
                  </div>
                )
              }}
            />
            <Bar dataKey="ok" stackId="calls" fill="var(--accent)" radius={[0, 0, 0, 0]} />
            <Bar dataKey="errors" stackId="calls" fill="var(--danger)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <RankList
          title="Tools"
          rows={usage.tools.map((t) => ({
            key: t.tool,
            label: t.tool,
            calls: t.calls,
            note: t.errors ? `${t.errors} failed` : undefined,
          }))}
        />
        <RankList
          title="Packages"
          rows={usage.packages.map((p) => ({ key: p.name, label: p.name, calls: p.calls }))}
        />
        <RankList
          title="People and clients"
          rows={[
            ...usage.people.map((p) => ({ key: `p:${p.id}`, label: p.name, calls: p.calls })),
            ...usage.clients.map((c) => ({
              key: `c:${c.client}`,
              label: c.client,
              calls: c.calls,
              note: 'client',
            })),
          ]}
        />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold">Recent calls</h3>
        {usage.recent.length ? (
          <Table label="Recent MCP calls">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Tool</Th>
                <Th>About</Th>
                <Th>Who</Th>
                <Th>Client</Th>
                <Th align="right">Time</Th>
              </tr>
            </thead>
            <tbody>
              {usage.recent.map((call, index) => (
                <tr key={`${call.at} ${index}`}>
                  <Td className="whitespace-nowrap text-muted">{formatRelative(call.at)}</Td>
                  <Td>
                    <span className="font-mono text-xs">{call.tool}</span>
                    {call.ok ? null : (
                      <Chip className="ml-2" tone="danger" size="sm">
                        failed
                      </Chip>
                    )}
                  </Td>
                  <Td className="font-mono text-xs">{call.subject ?? '—'}</Td>
                  <Td>
                    {usage.people.find((p) => p.id === call.principal)?.name ?? call.principal}
                  </Td>
                  <Td className="text-xs text-muted">{call.client ?? '—'}</Td>
                  <Td align="right" className="tabular text-muted">
                    {call.durationMs} ms
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            icon={<Bot />}
            title="No calls yet"
            description="Connect an agent with a token; its calls show up here."
          />
        )}
      </div>
    </div>
  )
}

function RankList({
  title,
  rows,
}: {
  title: string
  rows: { key: string; label: string; calls: number; note?: string | undefined }[]
}) {
  const max = Math.max(1, ...rows.map((row) => row.calls))
  return (
    <div className="rounded-2xl border border-border p-4">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      {rows.length ? (
        <ul className="flex flex-col gap-2">
          {rows.slice(0, 8).map((row) => (
            <li key={row.key} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate font-mono text-xs">{row.label}</span>
                <span className="tabular shrink-0 text-muted">
                  {row.calls}
                  {row.note ? <span className="ml-1 text-xs">· {row.note}</span> : null}
                </span>
              </div>
              <span className="h-1 overflow-hidden rounded-full bg-default">
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${(row.calls / max) * 100}%` }}
                />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Nothing yet.</p>
      )}
    </div>
  )
}
