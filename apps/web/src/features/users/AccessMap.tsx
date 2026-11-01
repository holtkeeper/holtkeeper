import type { UserView } from '@holtkeeper/api'
import {
  type Connection,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react'
import { ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useGroups, useUserMutations } from '../../api/queries.ts'
import { accessMap, withGrant, withoutGrant } from '../../lib/access-map.ts'
import { layeredLayout } from '../../lib/graph.ts'
import { Avatar, type LinkEdge, LinkLine, Panel, notify, useTheme } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

type UserData = { name: string; avatarUrl: string; disabled: boolean; you: boolean; dim: boolean }
type ScopeData = { label: string; idle: boolean; dim: boolean }
type UserNode = Node<UserData & { editable: boolean }, 'user'>
type ScopeNode = Node<ScopeData, 'scope'>

const USER = { width: 200, height: 44 }
const SCOPE = { width: 220, height: 40 }
const HANDLE = '!border-0 !bg-border-tertiary'

function UserCard({ data }: NodeProps<UserNode>) {
  return (
    <div
      className="flex h-full w-full cursor-pointer items-center gap-2 overflow-hidden rounded-xl border border-border bg-surface px-2.5 shadow-surface transition-opacity"
      style={{ opacity: data.dim ? 0.35 : data.disabled ? 0.6 : 1 }}
      title={data.disabled ? `${data.name} (disabled)` : data.name}
    >
      <Avatar src={data.avatarUrl} name={data.name} size="sm" />
      <span className="truncate text-[12px] font-medium">{data.name}</span>
      {data.you ? <span className="text-[10px] text-muted">you</span> : null}
      <Handle
        type="source"
        position={Position.Right}
        className={`${HANDLE} ${data.editable ? '!size-3 !bg-accent-soft-foreground' : '!size-1.5'}`}
        title={data.editable ? 'Drag to a scope to grant read access there' : undefined}
      />
    </div>
  )
}

function ScopeCard({ data }: NodeProps<ScopeNode>) {
  return (
    <div
      className="flex h-full w-full items-center overflow-hidden rounded-xl border border-border bg-surface px-3 shadow-surface transition-opacity"
      style={{
        opacity: data.dim ? 0.35 : data.idle ? 0.6 : 1,
        borderStyle: data.idle ? 'dashed' : 'solid',
      }}
      title={data.label}
    >
      <Handle type="target" position={Position.Left} className={`${HANDLE} !size-1.5`} />
      <span className="truncate font-mono text-[11px]">{data.label}</span>
    </div>
  )
}

const nodeTypes = { user: UserCard, scope: ScopeCard }
const edgeTypes = { link: LinkLine }

/**
 * Who may do what where: users linked to the scopes of their grants, captioned with the actions.
 * With `users:write`, dragging a user onto a scope grants read access there, the × on a
 * highlighted link revokes that scope (never your own), and clicking a user opens their grants.
 */
export function AccessMap({
  users,
  onEdit,
}: {
  users: readonly UserView[]
  onEdit: (user: UserView) => void
}) {
  const { theme } = useTheme()
  const { can, principal } = useSession()
  const writable = can('users:write')
  const groups = useGroups(can('settings:read'))
  const { update } = useUserMutations()
  const [focus, setFocus] = useState<string | null>(null)
  const map = useMemo(
    () =>
      accessMap(
        users,
        (groups.data?.entries ?? []).map((group) => group.id),
      ),
    [users, groups.data],
  )
  const editable = writable && !update.isPending
  const userOf = (id: string) => users.find((user) => `user:${user.id}` === id)

  const save = (user: UserView, grants: UserView['grants'], message: string) =>
    update.mutate(
      { id: user.id, input: { grants } },
      {
        onSuccess: () => notify.success(message, user.name),
        onError: (error) => notify.error('Not changed', messageOf(error)),
      },
    )

  const near = new Set<string>()
  if (focus) {
    near.add(focus)
    for (const edge of map.edges) {
      if (edge.from === focus) near.add(edge.to)
      if (edge.to === focus) near.add(edge.from)
    }
  }
  const dim = (id: string) => focus !== null && !near.has(id)
  const placed = new Map(
    layeredLayout(
      [
        ...map.users.map((user) => ({ id: user.id, ...USER })),
        ...map.scopes.map((scope) => ({ id: scope.id, ...SCOPE })),
      ],
      map.edges,
    ).map((box) => [box.id, box]),
  )
  const scopeX = USER.width + 160
  let idleY = Math.max(0, ...[...placed.values()].map((box) => box.y + box.height)) + 24
  for (const scope of map.scopes) {
    if (scope.idle) {
      placed.set(scope.id, { id: scope.id, ...SCOPE, x: scopeX, y: idleY })
      idleY += SCOPE.height + 12
    } else {
      const box = placed.get(scope.id)
      if (box) placed.set(scope.id, { ...box, x: Math.max(box.x, scopeX) })
    }
  }
  const position = (id: string) => ({ x: placed.get(id)?.x ?? 0, y: placed.get(id)?.y ?? 0 })
  const nodes: (UserNode | ScopeNode)[] = [
    ...map.users.map((user): UserNode => ({
      id: user.id,
      type: 'user',
      position: position(user.id),
      ...USER,
      data: {
        name: user.name,
        avatarUrl: user.avatarUrl,
        disabled: user.disabled,
        you: user.userId === principal?.id,
        dim: dim(user.id),
        editable,
      },
      draggable: false,
    })),
    ...map.scopes.map((scope): ScopeNode => ({
      id: scope.id,
      type: 'scope',
      position: position(scope.id),
      ...SCOPE,
      data: { label: scope.label, idle: scope.idle, dim: dim(scope.id) },
      draggable: false,
    })),
  ]
  const edges: LinkEdge[] = map.edges.map((edge) => {
    const lit = focus !== null && (edge.from === focus || edge.to === focus)
    const user = userOf(edge.from)
    const own = user?.id === principal?.id
    return {
      id: `${edge.from}->${edge.to}`,
      type: 'link',
      source: edge.from,
      target: edge.to,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: {
        stroke: lit ? 'var(--accent)' : 'var(--border-tertiary)',
        opacity: focus !== null && !lit ? 0.3 : 1,
      },
      data: {
        ...(focus === null || lit ? { label: edge.label } : {}),
        ...(lit && editable && user && !own
          ? {
              onRemove: () =>
                save(user, withoutGrant(user.grants, edge.to), 'Access in that scope revoked'),
              removeLabel: 'Revoke access in this scope',
            }
          : {}),
      },
    }
  })
  const height = Math.max(0, ...[...placed.values()].map((box) => box.y + box.height))
  const linked = new Set(map.edges.map((edge) => `${edge.from}->${edge.to}`))
  const canLink = (connection: Connection | Edge) =>
    connection.source.startsWith('user:') &&
    connection.target.startsWith('scope:') &&
    !linked.has(`${connection.source}->${connection.target}`)

  return (
    <Panel
      title="Access map"
      description={
        writable
          ? 'Users and the scopes they hold grants in, captioned with the actions. Drag from a user to a scope to grant read access there; hover a user and press × on a link to revoke it (not on your own); click a user to choose exact actions.'
          : 'Users and the scopes they hold grants in, captioned with the actions. Hover a card to follow its links.'
      }
    >
      <div
        className="overflow-hidden rounded-xl border border-border"
        style={{ height: Math.min(height + 48, 720) }}
        onMouseLeave={() => setFocus(null)}
        role="figure"
        aria-label={`Access map: ${map.users.length} users, ${map.scopes.length} scopes`}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={theme}
          fitView
          fitViewOptions={{ padding: 0.08 }}
          minZoom={0.3}
          nodesConnectable={editable}
          nodesDraggable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          zoomOnScroll={false}
          preventScrolling={false}
          isValidConnection={canLink}
          onConnect={(connection) => {
            const user = userOf(connection.source)
            const scope = map.scopes.find((s) => s.id === connection.target)
            if (user && scope)
              save(user, withGrant(user.grants, scope.scope), `Can read ${scope.label}`)
          }}
          onNodeMouseEnter={(_, node) => setFocus(node.id)}
          onEdgeMouseEnter={(_, edge) => setFocus(edge.source)}
          onPaneClick={() => setFocus(null)}
          onNodeClick={(_, node) => {
            const user = userOf(node.id)
            if (user && writable) onEdit(user)
          }}
          proOptions={{ hideAttribution: true }}
        />
      </div>
      {map.users.length === 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <ShieldCheck className="size-3.5" />
          No users yet.
        </p>
      ) : null}
    </Panel>
  )
}
