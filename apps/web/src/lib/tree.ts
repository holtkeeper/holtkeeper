import type { TreeNode } from '@holtkeeper/api'

/** A tree node with every value filled in: leaves keep theirs, parents sum their children. */
export interface SizedNode {
  name: string
  value: number
  tone?: TreeNode['tone']
  children?: SizedNode[]
}

/** Fills in parent values and drops empty branches; children are sorted largest first. */
export function sizeTree(node: TreeNode): SizedNode {
  const children = (node.children ?? []).map(sizeTree).filter((child) => child.value > 0)
  const sum = children.reduce((total, child) => total + child.value, 0)
  const value = children.length ? (node.value ?? sum) : (node.value ?? 0)
  return {
    name: node.name,
    value,
    ...(node.tone ? { tone: node.tone } : {}),
    ...(children.length ? { children: children.toSorted((a, b) => b.value - a.value) } : {}),
  }
}

/** The node reached by following child names from the root; the deepest valid node otherwise. */
export function nodeAt(
  root: SizedNode,
  path: readonly string[],
): { node: SizedNode; path: string[] } {
  let node = root
  const walked: string[] = []
  for (const name of path) {
    const next = node.children?.find((child) => child.name === name)
    if (!next) break
    node = next
    walked.push(name)
  }
  return { node, path: walked }
}

/**
 * Children of a node for display, keeping the `limit` largest and folding the rest into one
 * `Other` node so tiny slices stay readable.
 */
export function visibleChildren(node: SizedNode, limit = 40): SizedNode[] {
  const children = node.children ?? []
  if (children.length <= limit) return children
  const kept = children.slice(0, limit - 1)
  const rest = children.slice(limit - 1)
  return [
    ...kept,
    {
      name: `Other (${rest.length})`,
      value: rest.reduce((total, child) => total + child.value, 0),
    },
  ]
}
