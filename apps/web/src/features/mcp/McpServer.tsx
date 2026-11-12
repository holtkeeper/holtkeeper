import type { McpTokenView } from '@holtkeeper/api'
import { KeyRound, Trash2, Wrench } from 'lucide-react'
import { type ReactNode, useDeferredValue, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useCreateMcpToken,
  useMcpTokens,
  useMcpTools,
  useMcpUsage,
  useRevokeMcpToken,
} from '../../api/queries.ts'
import { formatCount, formatDate, formatRelative } from '../../lib/format.ts'
import {
  type TokenStatus,
  tokenStatus,
  tokenStatusCounts,
  tokenStatusLabels,
} from '../../lib/mcp-tokens.ts'
import { callsByToken } from '../../lib/mcp-usage.ts'
import {
  type McpClient,
  type McpTool,
  groupTools,
  mcpClients,
  mcpSetup,
  tokenLifetimes,
  toolParams,
} from '../../lib/mcp.ts'
import {
  Button,
  Chip,
  ConfirmDialog,
  CopyButton,
  CopyField,
  Dialog,
  EmptyState,
  ErrorState,
  Notice,
  Placeholder,
  SearchInput,
  Segmented,
  SegmentedTabs,
  Strip,
  Switch,
  Table,
  Td,
  Tag,
  TextField,
  Th,
  notify,
} from '../../ui/index.ts'
import { MyUsage } from './MyUsage.tsx'

/** Where the endpoint lives as the server sees it, falling back to this origin. */
const useEndpoint = () => useMcpUsage(7).data?.endpoint ?? `${window.location.origin}/mcp`

const steps = [
  [
    'Create a token',
    'One per machine or agent. Read-only unless you allow release steps or tasks.',
  ],
  ['Add the server to your client', 'Claude Code, Cursor or any Streamable HTTP client.'],
  [
    'Ask about your code',
    'Agents look up exports, usages and upgrade impact of your packages, and version-exact docs, changes and issues of third-party libraries.',
  ],
] as const

/**
 * Account › Connect agents: one flow from the three steps to the viewer's MCP tokens with their
 * status and calls, the client setup per client, the viewer's own usage and the reference of the tools the endpoint offers them.
 * `creating` opens the New token dialog, which the Account header's primary action drives.
 */
export function McpServer({
  creating = false,
  onCreating = () => {},
}: {
  creating?: boolean
  onCreating?: (open: boolean) => void
}) {
  const endpoint = useEndpoint()
  return (
    <div className="flex flex-col gap-5">
      <div className="flex justify-end">
        <a href="#tool-reference" className="text-xs text-muted hover:text-foreground">
          Tool reference
        </a>
      </div>
      <ol className="-mx-4 grid border-y border-line sm:grid-cols-3">
        {steps.map(([title, text], index) => (
          <li
            key={title}
            className="flex gap-3 border-line px-4 py-3 not-first:border-t sm:not-first:border-t-0 sm:not-first:border-l"
          >
            <span className="mono flex size-5 shrink-0 items-center justify-center rounded-full border border-line-strong text-[11px] text-muted">
              {index + 1}
            </span>
            <span className="flex flex-col gap-0.5 text-[12.5px]">
              <span className="font-medium">{title}</span>
              <span className="text-muted">{text}</span>
            </span>
          </li>
        ))}
      </ol>
      <TokensPanel endpoint={endpoint} open={creating} onOpen={onCreating} />
      <div className="grid items-start gap-5 xl:grid-cols-2">
        <ConnectPanel endpoint={endpoint} />
        <MyUsage />
      </div>
      <ToolReference />
    </div>
  )
}

function Block({
  id,
  title,
  description,
  actions,
  children,
}: {
  id?: string
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      {...(id && { id })}
      aria-label={title}
      className="flex flex-col rounded-[10px] border border-line"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {description ? <span className="text-xs text-muted">{description}</span> : null}
        {actions ? <div className="ms-auto flex items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}

function ConnectPanel({ endpoint }: { endpoint: string }) {
  const [client, setClient] = useState<McpClient>('claude-code')
  const setup = mcpSetup(endpoint)
  const code = setup[mcpClients.find((each) => each.id === client)!.field]
  return (
    <Block title="Client setup" description="Streamable HTTP, stateless, read by default">
      <div className="flex flex-col gap-3 px-3.5 py-3 text-[12.5px]">
        <CopyField label="MCP endpoint" value={endpoint} />
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedTabs
            aria-label="Client"
            items={mcpClients}
            selected={client}
            onSelect={(id) => setClient(mcpClients.find((each) => each.id === id)?.id ?? client)}
          />
          <span className="ms-auto">
            <CopyButton text={() => code}>Copy</CopyButton>
          </span>
        </div>
        <pre className="mono overflow-x-auto rounded-[7px] border border-line bg-raise px-3 py-2 text-[12px] leading-relaxed">
          {`# Replace <token> with one of your tokens\n${code}`}
        </pre>
        <p className="text-xs text-muted">
          The same token reads <code>/api/api-surface/*</code> and <code>/api/dependencies*</code>{' '}
          with the same <code>Authorization</code> header. Paste it into one client only; create
          another token for each machine.
        </p>
      </div>
    </Block>
  )
}

function ToolReference() {
  const tools = useMcpTools()
  const [query, setQuery] = useState('')
  const needle = useDeferredValue(query).trim().toLowerCase()
  const matches = (tool: McpTool) =>
    !needle ||
    tool.name.toLowerCase().includes(needle) ||
    (tool.description ?? '').toLowerCase().includes(needle)
  const groups = tools.data ? groupTools(tools.data.filter(matches)) : []
  return (
    <Block
      id="tool-reference"
      title="Tool reference"
      {...(tools.data && { description: `${tools.data.length} tools you get` })}
      actions={
        <SearchInput
          aria-label="Filter tools"
          placeholder="Tool name or description"
          value={query}
          onChange={setQuery}
          className="w-64"
        />
      }
    >
      <div className="flex flex-col gap-4 px-3.5 py-3">
        {tools.isPending ? (
          <Placeholder className="h-64" />
        ) : tools.isError ? (
          <ErrorState error={tools.error} />
        ) : (
          <>
            <p className="text-xs text-muted">
              They answer only about repositories you can read and only read, except that agents can
              propose knowledge entries for review. Agents pick them on their own; name a package,
              symbol or error and they call the right ones.
            </p>
            {groups.length ? (
              groups.map((group) => (
                <section key={group.id} aria-label={group.label} className="flex flex-col gap-2">
                  <h4 className="text-[12.5px] font-semibold">
                    {group.label}
                    {group.description ? (
                      <span className="ms-2 font-normal text-muted">{group.description}</span>
                    ) : null}
                  </h4>
                  <div className="flex flex-col">
                    {group.tools.map((tool) => (
                      <ToolCard key={tool.name} tool={tool} />
                    ))}
                  </div>
                </section>
              ))
            ) : (
              <EmptyState icon={<Wrench />} title="No tool matches" />
            )}
          </>
        )}
      </div>
    </Block>
  )
}

function ToolCard({ tool }: { tool: McpTool }) {
  const params = toolParams(tool)
  return (
    <div
      id={`tool-${tool.name}`}
      className="flex flex-col gap-2 border-b border-line py-3 first:pt-0 last:border-b-0 last:pb-0"
    >
      <span className="mono text-[12.5px] font-semibold">{tool.name}</span>
      {tool.description ? <p className="text-[12.5px] text-muted">{tool.description}</p> : null}
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

function TokensPanel({
  endpoint,
  open,
  onOpen: setOpen,
}: {
  endpoint: string
  open: boolean
  onOpen: (open: boolean) => void
}) {
  const tokens = useMcpTokens()
  const create = useCreateMcpToken()
  const revoke = useRevokeMcpToken()
  const [name, setName] = useState('')
  const [lifetime, setLifetime] = useState<(typeof tokenLifetimes)[number]['id']>('90')
  const [release, setRelease] = useState(false)
  const [runTasks, setRunTasks] = useState(false)
  const [secret, setSecret] = useState<string | undefined>(undefined)
  const [revoking, setRevoking] = useState<string | undefined>(undefined)

  const close = (next: boolean) => {
    setOpen(next)
    if (!next) {
      setSecret(undefined)
      setName('')
      setRelease(false)
      setRunTasks(false)
    }
  }
  const submit = () =>
    create.mutate(
      {
        name: name.trim() || 'MCP client',
        expiresInDays: Number(lifetime),
        ...(release || runTasks
          ? {
              scopes: [
                ...(release ? (['release'] as const) : []),
                ...(runTasks ? (['tasks'] as const) : []),
              ],
            }
          : {}),
      },
      {
        onSuccess: (result) => setSecret(result.secret),
        onError: (error) => notify.error('Not created', messageOf(error)),
      },
    )

  return (
    <Block title="Your tokens" description="For the MCP endpoint and the catalog API">
      {tokens.isPending ? (
        <Placeholder className="m-3.5 h-32" />
      ) : tokens.isError ? (
        <div className="p-3.5">
          <ErrorState error={tokens.error} />
        </div>
      ) : !tokens.data.available ? (
        <div className="p-3.5">
          <Notice title="Tokens are unavailable">
            The store keeps no key-value state; signed-in requests still reach the endpoint.
          </Notice>
        </div>
      ) : tokens.data.tokens.length ? (
        <TokenTable tokens={tokens.data.tokens} onRevoke={setRevoking} />
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
          secret
            ? 'Copy it now; it is not shown again.'
            : 'Read-only access to the catalog and release state as you.'
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
            <Switch
              label="Release steps"
              isSelected={release}
              onChange={setRelease}
              description="Lets agents run release_step where you may run releases; each step still needs a preview and a confirm token."
            />
            <Switch
              label="Run tasks"
              isSelected={runTasks}
              onChange={setRunTasks}
              description="Lets start_task queue code changes and request_review ask for reviews where you may run tasks; without it start_task only proposes them for approval."
            />
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
    </Block>
  )
}

const statusOrder: readonly TokenStatus[] = ['active', 'expiring', 'expired', 'unused']

function TokenTable({
  tokens,
  onRevoke,
}: {
  tokens: readonly McpTokenView[]
  onRevoke: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const calls = callsByToken(useMcpUsage(7).data?.tokens)
  const needle = query.trim().toLowerCase()
  const now = new Date()
  const counts = tokenStatusCounts(tokens, now)
  const shown = tokens.filter(
    (token) =>
      !needle ||
      token.name.toLowerCase().includes(needle) ||
      token.prefix.toLowerCase().includes(needle),
  )
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center">
        <Strip
          label="Token status"
          className="flex-1 border-b-0"
          cells={statusOrder.map((status) => ({
            value: counts[status],
            label: tokenStatusLabels[status].label.toLowerCase(),
            tone:
              tokenStatusLabels[status].tone === 'default'
                ? 'none'
                : tokenStatusLabels[status].tone,
          }))}
        />
        <SearchInput
          aria-label="Filter tokens"
          placeholder="Filter tokens"
          value={query}
          onChange={setQuery}
          className="me-3.5 w-56"
        />
      </div>
      <Table label="MCP tokens">
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Status</Th>
            <Th>Allows</Th>
            <Th>Token</Th>
            <Th>Expires</Th>
            <Th>Last used</Th>
            <Th align="right">Calls, 7 days</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {shown.map((token) => {
            const status = tokenStatusLabels[tokenStatus(token, now)]
            return (
              <tr key={token.id}>
                <Td className="font-medium">{token.name}</Td>
                <Td>
                  <Tag tone={status.tone} dot>
                    {status.label}
                  </Tag>
                </Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    <Tag>Read</Tag>
                    {token.scopes?.includes('release') ? (
                      <Tag tone="warning">Release steps</Tag>
                    ) : null}
                    {token.scopes?.includes('tasks') ? <Tag tone="warning">Run tasks</Tag> : null}
                  </span>
                </Td>
                <Td className="mono text-xs text-muted">{token.prefix}…</Td>
                <Td className="text-muted">
                  {token.expiresAt ? formatDate(token.expiresAt) : 'never'}
                </Td>
                <Td className="text-muted">
                  {token.lastUsedAt ? formatRelative(token.lastUsedAt) : 'never'}
                </Td>
                <Td align="right" className="mono">
                  {formatCount(calls.get(token.id) ?? 0)}
                </Td>
                <Td align="right">
                  <Button
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    aria-label={`Revoke ${token.name}`}
                    onPress={() => onRevoke(token.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </Td>
              </tr>
            )
          })}
        </tbody>
      </Table>
      <p className="border-t border-line px-3.5 py-2.5 text-xs text-muted">
        {tokens.length} {tokens.length === 1 ? 'token' : 'tokens'} · a revoked token stops working
        at once
      </p>
    </div>
  )
}
