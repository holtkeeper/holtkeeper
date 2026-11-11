import { messageOf } from '../../api/client.ts'
import { usePreferences, useRepos, useSetPreferences } from '../../api/queries.ts'
import { formatGroupMatch, parseGroupMatch, validateGroupMatch } from '../../lib/scope.ts'
import { Button, ErrorState, Panel, Placeholder, TagInput, notify } from '../../ui/index.ts'

/** The groups the *My team* scope shows; defaults to the groups in the viewer's grants. */
export function HomeGroups() {
  const preferences = usePreferences()
  const repos = useRepos()
  const save = useSetPreferences()
  const groups = [...new Set((repos.data?.repos ?? []).flatMap((r) => r.groups))].toSorted()
  const update = (homeGroups: string[] | null) =>
    save.mutate(
      { homeGroups: homeGroups?.map(parseGroupMatch) ?? null },
      { onError: (error) => notify.error('Home groups not saved', messageOf(error)) },
    )

  return (
    <Panel
      title="Home groups"
      description="What My team shows on list pages. A default view, not a permission."
      actions={
        preferences.data && !preferences.data.homeGroupsFromGrants ? (
          <Button variant="ghost" size="sm" isPending={save.isPending} onPress={() => update(null)}>
            Use my grants
          </Button>
        ) : null
      }
    >
      {preferences.isPending ? (
        <Placeholder className="h-10" />
      ) : preferences.isError ? (
        <ErrorState error={preferences.error} />
      ) : (
        <TagInput
          label="Home groups"
          hideLabel
          values={preferences.data.homeGroups.map(formatGroupMatch)}
          onChange={update}
          validate={validateGroupMatch}
          suggestions={groups}
          placeholder="Add a group, or groups joined with +"
          description={
            preferences.data.homeGroupsFromGrants
              ? 'From your grants until you change them.'
              : undefined
          }
        />
      )}
    </Panel>
  )
}
