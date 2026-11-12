import { Settings2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { useSettings } from '../../api/queries.ts'
import { neighbours } from '../../lib/flow.ts'
import { definitionsOf } from '../../lib/settings-sections.ts'
import { Button, EmptyState, ErrorState, Placeholder, SideSheet, Tooltip } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { SettingEntries } from './SettingEntries.tsx'

/**
 * The settings of `keys` in a side sheet, each with its entries per scope and its editor. With
 * several settings each gets an underline tab, and J and K step through them.
 */
function SettingsSheet({
  title,
  keys,
  onClose,
}: {
  title: string
  keys: readonly string[]
  onClose: () => void
}) {
  const settings = useSettings()
  const definitions = settings.data ? definitionsOf(settings.data.definitions, keys) : []
  const [selected, setSelected] = useState<string>()
  const current = definitions.find((d) => d.key === selected) ?? definitions[0]
  const step = neighbours(
    definitions.map((d) => d.key),
    current?.key,
  )
  const several = definitions.length > 1
  return (
    <SideSheet
      open
      onClose={onClose}
      title={title}
      {...(current ? { id: current.key } : {})}
      {...(several && step.index >= 0 ? { index: step.index, total: definitions.length } : {})}
      {...(several && step.previous ? { onPrevious: () => setSelected(step.previous) } : {})}
      {...(several && step.next ? { onNext: () => setSelected(step.next) } : {})}
      {...(several && current
        ? {
            tabs: {
              items: definitions.map((d) => ({ id: d.key, label: d.label })),
              selected: current.key,
              onSelect: setSelected,
              'aria-label': 'Settings',
            },
          }
        : {})}
    >
      {settings.isPending ? (
        <Placeholder className="h-40" />
      ) : settings.isError ? (
        <ErrorState error={settings.error} />
      ) : !current ? (
        <EmptyState icon={<Settings2 />} title="Nothing to set here" />
      ) : (
        <SettingEntries key={current.key} data={settings.data} definition={current} />
      )}
    </SideSheet>
  )
}

/**
 * A page's "Configure" entry: `configure` is the `Page` prop that opens the settings of `keys`
 * (usually its analyzers' options) in a side sheet, `sheet` the sheet to render. Without
 * `settings:read` there is no `configure` and no sheet.
 */
export function useConfigure(
  title: string,
  keys: readonly string[],
): { configure?: { onPress: () => void }; sheet: ReactNode } {
  const { can } = useSession()
  const [open, setOpen] = useState(false)
  if (!can('settings:read')) return { sheet: null }
  return {
    configure: { onPress: () => setOpen(true) },
    sheet: open ? <SettingsSheet title={title} keys={keys} onClose={() => setOpen(false)} /> : null,
  }
}

/**
 * A gear button that opens the page's settings (`keys`, usually its analyzers' options) in a side
 * sheet; hidden without `settings:read`. With `label` it is a small labelled button instead.
 */
export function SettingsButton({
  title,
  keys,
  label,
}: {
  title: string
  keys: readonly string[]
  label?: string
}) {
  const { can } = useSession()
  const [open, setOpen] = useState(false)
  if (!can('settings:read')) return null
  return (
    <>
      {label ? (
        <Button variant="secondary" size="sm" onPress={() => setOpen(true)}>
          <Settings2 className="size-3.5" />
          {label}
        </Button>
      ) : (
        <Tooltip content={title}>
          <Button variant="secondary" isIconOnly aria-label={title} onPress={() => setOpen(true)}>
            <Settings2 className="size-4" />
          </Button>
        </Tooltip>
      )}
      {open ? <SettingsSheet title={title} keys={keys} onClose={() => setOpen(false)} /> : null}
    </>
  )
}
