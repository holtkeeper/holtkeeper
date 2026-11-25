/**
 * Toolsets of the MCP endpoint a token can turn on or off, in the order clients list them.
 * Secret reports are not among them: each token's reporting choice governs that toolset.
 */
export const mcpToolsetNames = [
  'packages',
  'knowledge',
  'rules',
  'assets',
  'reviews',
  'qa',
  'releases',
  'ask',
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
    name: 'packages',
    label: 'Packages',
    description:
      'API, docs, source, versions, changes and usages of your own packages and the third-party libraries your repositories depend on.',
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
      'The rules agents follow in a repository, with commit, release, asset and test id conventions.',
    defaultOn: true,
  },
  {
    name: 'assets',
    label: 'Assets',
    description: 'Files of a repository that break its asset policy or could be smaller.',
    defaultOn: false,
  },
  {
    name: 'reviews',
    label: 'Reviews',
    description: 'Ask for Holtkeeper’s review of a merge request and read its findings.',
    defaultOn: true,
  },
  {
    name: 'qa',
    label: 'QA tasks',
    description:
      'Tasks of Releases › QA: their changes, test attribute changes and stored test notes.',
    defaultOn: false,
  },
  {
    name: 'releases',
    label: 'Releases',
    description:
      'How a repository releases, where its release stands, and the tasks, changelog and dependency changes between two versions. Read-only.',
    defaultOn: false,
  },
  {
    name: 'ask',
    label: 'Ask',
    description:
      'One question answered by an AI agent over the other tools, every claim backed by a source. Spends the AI budget; answers only while the `mcp.ask` setting is on.',
    defaultOn: true,
  },
]

/** Whether `value` names a toggleable MCP toolset. */
export const isMcpToolsetName = (value: string): value is McpToolsetName =>
  (mcpToolsetNames as readonly string[]).includes(value)

/** The toolsets a token serves when its owner toggled none, in catalog order. */
export const defaultMcpToolsets: readonly McpToolsetName[] = mcpToolsetCatalog
  .filter((toolset) => toolset.defaultOn)
  .map((toolset) => toolset.name)
