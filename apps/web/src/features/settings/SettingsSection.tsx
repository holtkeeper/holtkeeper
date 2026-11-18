import type { SettingDefinitionView, SettingList } from '@holtkeeper/api'
import type { ReactNode } from 'react'

import { useSettings } from '../../api/queries.ts'
import {
  type SettingsSectionId,
  advancedSettingKeys,
  sectionDefinitions,
  settingAnchor,
} from '../../lib/settings-sections.ts'
import { ErrorState, Placeholder } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { SettingEntries } from './SettingEntries.tsx'

/** One titled block of a Settings section, such as Users or Storage. */
export function SettingsSection({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold leading-tight">{title}</h2>
          {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}

function Entries({
  definitions,
  data,
}: {
  definitions: readonly SettingDefinitionView[]
  data: SettingList
}) {
  return definitions.map((definition) => (
    <div key={definition.key} id={settingAnchor(definition.key)} className="scroll-mt-4">
      <SettingEntries data={data} definition={definition} />
    </div>
  ))
}

/**
 * The settings `sectionDefinitions` gives a Settings section, with their entries per scope under
 * one titled block; rarely changed ones fold under Advanced. Renders nothing without
 * `settings:read` or when the section has no setting.
 */
export function SectionSettings({
  section,
  title,
  description,
}: {
  section: Exclude<SettingsSectionId, 'audit'>
  title: ReactNode
  description?: ReactNode
}) {
  const { can } = useSession()
  const settings = useSettings(can('settings:read'))
  if (!can('settings:read')) return null
  if (settings.isPending)
    return (
      <SettingsSection title={title} description={description}>
        <Placeholder className="h-40" />
      </SettingsSection>
    )
  if (settings.isError)
    return (
      <SettingsSection title={title} description={description}>
        <ErrorState error={settings.error} />
      </SettingsSection>
    )
  const definitions = sectionDefinitions(settings.data.definitions, section)
  if (!definitions.length) return null
  const main = definitions.filter((d) => !advancedSettingKeys.has(d.key))
  const advanced = definitions.filter((d) => advancedSettingKeys.has(d.key))
  return (
    <SettingsSection title={title} description={description}>
      <Entries definitions={main} data={settings.data} />
      {advanced.length ? (
        <details
          className="group flex flex-col gap-4"
          open={advanced.some((d) => window.location.hash === `#${settingAnchor(d.key)}`)}
        >
          <summary className="cursor-pointer text-sm text-muted hover:text-foreground">
            Advanced
          </summary>
          <div className="mt-4 flex flex-col gap-4">
            <Entries definitions={advanced} data={settings.data} />
          </div>
        </details>
      ) : null}
    </SettingsSection>
  )
}
