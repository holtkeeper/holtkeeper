/**
 * Toolsets of the MCP endpoint a token can turn on or off, in the order clients list them.
 * Secret reports are not among them: each token's reporting choice governs that toolset.
 */
export const mcpToolsetNames = [
  'catalog',
  'stack',
  'knowledge',
  'rules',
  'assets',
  'libraries',
  'reviews',
  'qa',
] as const

/** A toolset of the MCP endpoint a token can turn on or off. */
export type McpToolsetName = (typeof mcpToolsetNames)[number]

/** What people choose a toolset by. */
export interface McpToolsetInfo {
  name: McpToolsetName
  label: string
  /** What agents get with it, one sentence. */
  description: string
  /** Whether a token serves it unless its owner says otherwise. */
  defaultOn: boolean
}

/**
 * Every toggleable toolset with its label and default. Tokens follow the defaults for toolsets
 * their owner never toggled, so a toolset added later reaches existing tokens only when it is on
 * by default.
 */
export const mcpToolsetCatalog: readonly McpToolsetInfo[] = [
  {
    name: 'catalog',
    label: 'Package catalog',
    description:
      'Exports, versions, usages and upgrade impact of the packages your repositories publish.',
    defaultOn: true,
  },
  {
    name: 'stack',
    label: 'Stack',
    description: 'Frameworks, tools and dependencies a repository uses.',
    defaultOn: true,
  },
  {
    name: 'knowledge',
    label: 'Team knowledge',
    description: 'Search team rules and learned rules, propose learned rules.',
    defaultOn: true,
  },
  {
    name: 'rules',
    label: 'Repository rules',
    description:
      'The rules agents follow in a repository, test ids, commit conventions and release rules.',
    defaultOn: true,
  },
  {
    name: 'assets',
    label: 'Assets',
    description: 'Asset policies and the assets a repository ships.',
    defaultOn: true,
  },
  {
    name: 'libraries',
    label: 'Third-party libraries',
    description: 'Version-exact docs, changes, issues and source of the libraries in use.',
    defaultOn: true,
  },
  {
    name: 'reviews',
    label: 'Reviews',
    description: 'How Holtkeeper’s review of a merge request stands.',
    defaultOn: true,
  },
  {
    name: 'qa',
    label: 'QA tasks',
    description:
      'Tasks of Releases › QA: their changes, test attribute changes and stored test notes.',
    defaultOn: false,
  },
]

/** Whether `value` names a toggleable MCP toolset. */
export const isMcpToolsetName = (value: string): value is McpToolsetName =>
  (mcpToolsetNames as readonly string[]).includes(value)

/** The toolsets a token serves when its owner toggled none, in catalog order. */
export const defaultMcpToolsets: readonly McpToolsetName[] = mcpToolsetCatalog
  .filter((toolset) => toolset.defaultOn)
  .map((toolset) => toolset.name)
