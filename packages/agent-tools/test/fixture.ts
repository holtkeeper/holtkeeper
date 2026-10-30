import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { AgentTool, ToolContext, Toolset } from '@holtkeeper/agent'

const bigLines = Array.from({ length: 300 }, (_, i) => `export const value${i} = ${i}`)

const files: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0' }),
  'src/index.ts': `import { formatName, Greeter } from './util.ts'
import type { User } from './model.ts'

export function main(user: User): string {
  const greeter = new Greeter('Hi')
  return greeter.greet(formatName(user.name))
}
`,
  'src/util.ts': `/** Formats a name. */
export function formatName(name: string): string {
  return name.trim()
}

export class Greeter {
  prefix: string
  constructor(prefix: string) {
    this.prefix = prefix
  }
  greet(name: string): string {
    // TODO: localize formatName output
    return \`\${this.prefix} \${name}\`
  }
}
`,
  'src/model.ts': `export interface User {
  id: Id
  name: string
}

export type Id = string | number
`,
  'src/view.tsx': `import { main } from './index.ts'

export const View = () => <div>{main({ id: 1, name: 'a' })}</div>
`,
  'src/big.ts': `${bigLines.join('\n')}\n`,
  'node_modules/left-pad/package.json': JSON.stringify({
    name: 'left-pad',
    version: '2.1.0',
    description: 'Pads strings on the left.',
    types: 'index.d.ts',
  }),
  'node_modules/left-pad/README.md': `# left-pad

Pads a string.

## Install

npm i left-pad

## Usage

\`\`\`js
# not a heading
leftPad('a', 3)
\`\`\`
`,
  'node_modules/left-pad/CHANGELOG.md': `# Changelog

## [2.1.0] - 2024-05-01

- Added padEnd.

## [2.0.0] - 2024-01-01

### Breaking

- Removed callback API.

## 1.5.0

- Faster.

## v1.0.0

- First release.
`,
  'node_modules/left-pad/MIGRATION.md': `# Migration

## Migrating from v1 to v2

Callbacks are gone; use the return value.

## Migrating from v2 to v3

Nothing yet.
`,
  'node_modules/left-pad/index.d.ts': `/** Pads on the left. */
export declare function leftPad(text: string, length: number, fill?: string): string
export interface PadOptions {
  fill: string
}
export * from './extra'
`,
  'node_modules/left-pad/extra.d.ts': `export declare function padEnd(text: string, length: number): string
`,
}

export interface Fixture {
  dir: string
  ctx: ToolContext
  cleanup(): Promise<void>
}

/** A temp repository with TypeScript sources and a fake installed package. */
export async function createFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hk-agent-tools-'))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return {
    dir,
    ctx: { dir, signal: new AbortController().signal },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

/** The tool named `name` of `toolset`. */
function toolOf(toolset: Toolset, name: string): AgentTool {
  const tool = toolset.tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool
}

/** Runs a tool the way the MCP server does: input parsed by its schema first. */
export async function call(
  toolset: Toolset,
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const tool = toolOf(toolset, name)
  return tool.run(tool.input.parse(input), ctx)
}
