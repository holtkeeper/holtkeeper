import { useSettings } from '../../api/queries.ts'
import { type Space, entryNamesSpace, settingScopeOfSpace } from '../../lib/guide.ts'
import { knowledgeSettingKeys } from '../../lib/knowledge.ts'
import { SettingEntries } from '../settings/SettingEntries.tsx'
import { SettingsSheet } from '../settings/SettingsSheet.tsx'
import { useSession } from '../shell/session.ts'

/**
 * The machine-enforced policy of a section: the setting's entries made for this space, edited
 * with the setting's own form. Hidden without `settings:read`.
 */
export function PolicyBlock({
  settingKey,
  space,
  members,
}: {
  settingKey: string
  space: Space
  members: readonly string[]
}) {
  const { can } = useSession()
  const settings = useSettings(can('settings:read'))
  const definition = settings.data?.definitions.find((d) => d.key === settingKey)
  if (!definition || !settings.data) return null
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Policy</h3>
      <SettingEntries
        data={settings.data}
        definition={definition}
        entries={settings.data.settings.filter(
          (entry) => entry.key === settingKey && entryNamesSpace(entry.scope, space, members),
        )}
        initialScope={settingScopeOfSpace(space, members)}
        empty="Nothing set for this space; broader entries or the default apply."
      />
    </div>
  )
}

/** The Knowledge settings (what agents may add without review, review options) in a side sheet. */
export function KnowledgeSettingsSheet({ onClose }: { onClose: () => void }) {
  return <SettingsSheet title="Knowledge settings" keys={knowledgeSettingKeys} onClose={onClose} />
}
