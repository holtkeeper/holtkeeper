import type { McpToolsetInfo, McpToolsetName } from '@holtkeeper/api'

import { toggleToolset } from '../../lib/mcp-tokens.ts'
import { Checkbox, Tag } from '../../ui/index.ts'

/**
 * Which toolsets an MCP token serves: one checkbox per toolset of `catalog` with what agents get
 * from it; toolsets off by default say so. Used by the New token dialog and the per-token tools
 * dialog.
 */
export function ToolsetsChoice({
  catalog,
  value,
  onChange,
}: {
  catalog: readonly McpToolsetInfo[]
  value: readonly McpToolsetName[]
  onChange: (toolsets: McpToolsetName[]) => void
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm">Tools</legend>
      {catalog.map((toolset) => (
        <div key={toolset.name} className="flex flex-col gap-0.5">
          <Checkbox
            label={
              <span className="flex items-center gap-2">
                {toolset.label}
                {toolset.defaultOn ? null : <Tag>Off by default</Tag>}
              </span>
            }
            isSelected={value.includes(toolset.name)}
            onChange={(on) => onChange(toggleToolset(value, toolset.name, on, catalog))}
          />
          <span className="ps-7 text-xs text-muted">{toolset.description}</span>
        </div>
      ))}
      <p className="text-xs text-muted">
        Agents see only the tools of the toolsets you pick. Secret reports follow their own choice.
      </p>
    </fieldset>
  )
}
