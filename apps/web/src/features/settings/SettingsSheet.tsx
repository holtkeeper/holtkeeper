import { Settings2 } from 'lucide-react'
import { useState } from 'react'

import { useSettings } from '../../api/queries.ts'
import { definitionsOf } from '../../lib/settings-tabs.ts'
import { Button, EmptyState, ErrorState, Placeholder, SideSheet, Tooltip } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { SettingEntries } from './SettingEntries.tsx'

/** The settings of `keys` in a side sheet, each with its entries per scope and its editor. */
export function SettingsSheet({
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
  return (
    <SideSheet open onClose={onClose} title={title}>
      {settings.isPending ? (
        <Placeholder className="h-40" />
      ) : settings.isError ? (
        <ErrorState error={settings.error} />
      ) : definitions.length === 0 ? (
        <EmptyState icon={<Settings2 />} title="Nothing to set here" />
      ) : (
        <div className="flex flex-col gap-4">
          {definitions.map((definition) => (
            <SettingEntries key={definition.key} data={settings.data} definition={definition} />
          ))}
        </div>
      )}
    </SideSheet>
  )
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
