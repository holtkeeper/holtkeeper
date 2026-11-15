import type { Scope } from '@holtkeeper/api'
import { folderPattern } from '@holtkeeper/api'
import { FolderPlus, Globe2, Layers } from 'lucide-react'
import { useMemo } from 'react'

import { useDescribeScope, useRepos, useTeamNames, useTeamTitles } from '../../api/queries.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  folderPatterns,
  previewPatterns,
  reposMatching,
  validateRepoPattern,
} from '../../lib/scope.ts'
import { validateTeamKey } from '../../lib/team-titles.ts'
import { Button, Chip, Segmented, TagInput } from '../../ui/index.ts'

/**
 * Which repositories something applies to: everything, or owner teams plus path patterns
 * (`forge:folder/**`). Patterns preview live how many visible repositories they match.
 */
export function ScopeEditor({
  value,
  onChange,
  teams,
  allowTeams = true,
  folder,
  label = 'Scope',
}: {
  value: Scope
  onChange: (scope: Scope) => void
  /** Known teams, offered as suggestions; defaults to the owner teams of visible repositories. */
  teams?: readonly string[]
  /**
   * Whether teams are offered at all. Settings pass `false`: they are scoped by paths, and a team
   * field only shows when the entry already names teams.
   */
  allowTeams?: boolean
  /** The folder the editor was opened from, offered as a one-click "this folder" pattern. */
  folder?: { forge: string; folder: string }
  label?: string
}) {
  const mode = value.all ? 'all' : 'some'
  const titleOf = useTeamTitles()
  const known = useTeamNames(teams === undefined)
  const repos = useRepos().data?.repos
  const patterns = value.repos ?? []
  const showTeams = allowTeams || (value.teams?.length ?? 0) > 0
  const suggestions = useMemo(() => folderPatterns((repos ?? []).map((repo) => repo.repo)), [repos])
  const preview = repos ? previewPatterns(patterns, repos) : undefined
  const here = folder ? folderPattern(folder.folder, folder.forge) : undefined
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      <Segmented
        aria-label={`${label} mode`}
        options={[
          {
            id: 'all',
            label: (
              <span className="flex items-center gap-1.5">
                <Globe2 className="size-3.5" />
                Everything
              </span>
            ),
          },
          {
            id: 'some',
            label: (
              <span className="flex items-center gap-1.5">
                <Layers className="size-3.5" />
                {showTeams ? 'Teams and paths' : 'Paths'}
              </span>
            ),
          },
        ]}
        value={mode}
        onChange={(next) => onChange(next === 'all' ? { all: true } : { teams: [], repos: [] })}
      />
      {mode === 'some' ? (
        <div className="flex flex-col gap-3 rounded-xl border border-separator p-3">
          {showTeams ? (
            <TagInput
              label="Teams"
              values={value.teams ?? []}
              onChange={(next) => onChange({ ...value, teams: next })}
              placeholder="e.g. widgets"
              suggestions={teams ?? known}
              labelOf={titleOf}
              validate={validateTeamKey}
              description="Repositories any of these teams own"
            />
          ) : null}
          <TagInput
            label="Path patterns"
            values={patterns}
            onChange={(next) => onChange({ ...value, repos: next })}
            placeholder="e.g. acme/round/**"
            suggestions={suggestions}
            labelOf={
              repos
                ? (pattern) => `${pattern} · ${reposMatching(pattern, repos).length}`
                : undefined
            }
            validate={validateRepoPattern}
            description="Path globs, optionally prefixed by a forge id: work:acme/**, tools/cli"
          />
          {here && !patterns.includes(here) ? (
            <div>
              <Button
                size="sm"
                variant="ghost"
                onPress={() => onChange({ ...value, repos: [...patterns, here] })}
              >
                <FolderPlus className="size-3.5" />
                This folder: {here}
              </Button>
            </div>
          ) : null}
          {preview && patterns.length > 0 ? (
            <p className="text-xs text-muted" aria-live="polite">
              {preview.total === 0
                ? 'The patterns match no repository you can see yet.'
                : `Matches ${preview.total} ${preview.total === 1 ? 'repository' : 'repositories'}: ${preview.sample
                    .map((repo) => repoKey(repo.repo))
                    .join(', ')}${preview.total > preview.sample.length ? ', …' : ''}`}
            </p>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  )
}

/** Read-only scope summary. */
export function ScopeBadge({ scope }: { scope: Scope }) {
  const describeScope = useDescribeScope()
  return (
    <Chip tone={scope.all ? 'accent' : 'default'} className="max-w-full">
      <span className="truncate font-mono text-[11px]">{describeScope(scope)}</span>
    </Chip>
  )
}
