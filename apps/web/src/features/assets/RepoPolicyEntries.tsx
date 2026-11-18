import type { RepoRef } from '@holtkeeper/api'

import { useSettings } from '../../api/queries.ts'
import { repoKey } from '../../lib/repo.ts'
import { namesFocus } from '../../lib/scope.ts'
import { SettingEntries } from '../settings/SettingEntries.tsx'
import { useSession } from '../shell/session.ts'

/**
 * The entries of a policy setting made for one repository, edited with the setting's own form.
 * Hidden without `settings:read`.
 */
export function RepoPolicyEntries({ settingKey, repo }: { settingKey: string; repo: RepoRef }) {
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
          (entry) => entry.key === settingKey && namesFocus(entry.scope, { kind: 'repo', repo }),
        )}
        initialScope={{ repos: [repoKey(repo)] }}
        empty="Nothing set for this repository; broader entries or the default apply."
      />
    </div>
  )
}
