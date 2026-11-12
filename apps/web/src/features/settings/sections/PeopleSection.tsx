import type { CrossTeamLevel } from '@holtkeeper/api'
import { useQueryClient } from '@tanstack/react-query'

import { messageOf } from '../../../api/client.ts'
import { keys, useSettingMutations, useSettings, useUsers } from '../../../api/queries.ts'
import { plural } from '../../../lib/format.ts'
import { reachLevels, roleCounts } from '../../../lib/people.ts'
import { rolePresetIds, rolePresets } from '../../../lib/roles.ts'
import { ErrorState, Panel, Placeholder, Tag, notify } from '../../../ui/index.ts'
import { useSession } from '../../shell/session.ts'
import { People } from '../../users/People.tsx'
import { SettingEntries } from '../SettingEntries.tsx'
import { SettingsSection } from '../SettingsSection.tsx'

function Roles() {
  const { auth, can } = useSession()
  const users = useUsers(auth.provider === 'users' && can('users:read'))
  const counts = users.data ? roleCounts(users.data.users) : undefined
  return (
    <SettingsSection
      title={<span id="roles">Roles</span>}
      description="Four presets. Each person gets one, limited to the groups and repositories it applies to; grants matching none show as Custom and stay as they are."
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {rolePresetIds.map((id) => (
          <Panel key={id}>
            <div className="flex items-baseline gap-2">
              <h3 className="text-[13px] font-semibold">{rolePresets[id].label}</h3>
              <span className="flex-1" />
              {counts ? (
                <span className="text-xs text-muted">{plural(counts[id], 'person', 'people')}</span>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted">{rolePresets[id].description}</p>
          </Panel>
        ))}
      </div>
      {counts?.custom ? (
        <p className="text-xs text-muted">
          {plural(counts.custom, 'person has', 'people have')} custom grants.
        </p>
      ) : null}
    </SettingsSection>
  )
}

function Reach() {
  const { crossTeam, can, canGlobal } = useSession()
  const settings = useSettings(can('settings:read'))
  const { put } = useSettingMutations()
  const client = useQueryClient()
  const editable = canGlobal('settings:write')
  const org = settings.data?.settings.find(
    (entry) => entry.key === 'access.crossTeam' && entry.scope.all === true,
  )
  const choose = (level: CrossTeamLevel) =>
    put.mutate(
      { ...(org && { id: org.id }), key: 'access.crossTeam', scope: { all: true }, value: level },
      {
        onSuccess: () => void client.invalidateQueries({ queryKey: keys.me }),
        onError: (error) => notify.error('Not saved', messageOf(error)),
      },
    )
  return (
    <SettingsSection
      title={<span id="reach">Reach</span>}
      description="What everyone may read of other teams' repositories. One level for every person, team and agent: there are no per-team exceptions."
    >
      <div
        role="radiogroup"
        aria-label="Reading other teams' repositories"
        className="flex flex-col gap-1.5"
      >
        {reachLevels.map((text) => {
          const { level } = text
          const selected = crossTeam === level
          return (
            <label
              key={level}
              aria-label={text.label}
              className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-[12.5px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus ${
                selected ? 'border-line-strong bg-raise' : 'border-line'
              } ${editable ? 'cursor-pointer hover:bg-raise' : ''}`}
            >
              <input
                type="radio"
                name="reach"
                className="mt-0.5 accent-[var(--brand)]"
                checked={selected}
                disabled={!editable || put.isPending}
                onChange={() => choose(level)}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-1.5">
                  <b className="font-medium">{text.label}</b>
                  {selected ? <Tag>Current</Tag> : null}
                </span>
                <span className="text-xs text-muted">{text.description}</span>
              </span>
            </label>
          )
        })}
      </div>
      <p className="text-xs text-muted">
        Grants still decide everything else: other teams' findings, jobs, merge requests and
        releases stay hidden at every level.
      </p>
    </SettingsSection>
  )
}

function ReadOnlyRepos() {
  const { can } = useSession()
  const settings = useSettings(can('settings:read'))
  if (!can('settings:read')) return null
  const definition = settings.data?.definitions.find((d) => d.key === 'repo.freeze')
  return (
    <SettingsSection
      title="Read-only repositories"
      description="Holtkeeper still analyses these, but never pushes, comments, labels or opens merge requests there."
    >
      {settings.isPending ? (
        <Placeholder className="h-32" />
      ) : settings.isError ? (
        <ErrorState error={settings.error} />
      ) : definition ? (
        <SettingEntries data={settings.data} definition={definition} />
      ) : null}
    </SettingsSection>
  )
}

/** Settings › People & access: the people, the role presets, Reach and read-only repositories. */
export function PeopleSection() {
  const { can } = useSession()
  return (
    <>
      {can('users:read') ? <People /> : null}
      {can('users:read') ? <Roles /> : null}
      {can('settings:read') ? <Reach /> : null}
      <ReadOnlyRepos />
    </>
  )
}
