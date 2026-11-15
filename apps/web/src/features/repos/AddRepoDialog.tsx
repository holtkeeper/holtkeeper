import {
  type RepoAccessBatch,
  type RepoAccessResult,
  parentFolder,
  patternMatches,
} from '@holtkeeper/api'
import { X } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useCheckRepoAccess,
  useForgeMutations,
  useForges,
  usePutTeam,
  useRepos,
  useTeamTitles,
  useTeams,
} from '../../api/queries.ts'
import { plural } from '../../lib/format.ts'
import { type PathCheck, parsePastedPaths, pathCheck, withPaths } from '../../lib/repo.ts'
import {
  Button,
  Dot,
  LinkButton,
  Notice,
  Segmented,
  Select,
  SideSheet,
  TextField,
  notify,
} from '../../ui/index.ts'
import { toForgeDraft, toForgeInput } from '../credentials/forge-form.ts'
import { RepoExplorer } from './RepoExplorer.tsx'

/** Paths one access check takes. */
const MAX_PATHS = 50

const steps = ['Forge', 'Paths', 'Where'] as const

/**
 * Adds repositories in three steps: a forge, then paths (picked from the token's projects or
 * pasted, URLs trimmed) checked against the forge token in one batch, then where they go: a
 * team's owns (the team answers for them, settings and access follow its folders and team) or
 * the forge's fleet include list (no owner yet). Either puts the exact paths in the fleet. Opens
 * as a side sheet beside the list. Needs global `settings:write`.
 */
export function AddRepoDialog({ onClose }: { onClose: () => void }) {
  const titleOf = useTeamTitles()
  const forges = useForges()
  const teams = useTeams()
  const repos = useRepos()
  const putTeam = usePutTeam()
  const { put: putForge } = useForgeMutations()
  const check = useCheckRepoAccess()
  const forgeIds = (forges.data?.entries ?? []).map((entry) => entry.id)
  const [step, setStep] = useState(0)
  const [forge, setForge] = useState<string>()
  const [source, setSource] = useState<'pick' | 'paste'>('pick')
  const [picked, setPicked] = useState<string[]>([])
  const [pasted, setPasted] = useState('')
  const [removed, setRemoved] = useState<string[]>([])
  const [checked, setChecked] = useState<{ forge: string; batch: RepoAccessBatch }>()
  const [where, setWhere] = useState<'team' | 'fleet'>('team')
  const [teamId, setTeamId] = useState<string>()

  const selectedForge = forge ?? (forgeIds.length === 1 ? forgeIds[0] : undefined)
  const forgeEntry = forges.data?.entries.find((entry) => entry.id === selectedForge)
  const added = new Set(
    (repos.data?.repos ?? [])
      .filter((summary) => summary.repo.forge === selectedForge)
      .map((summary) => summary.repo.path),
  )
  const parsed = parsePastedPaths(pasted)
  const paths = [...new Set([...picked, ...parsed.paths])].filter((path) => !removed.includes(path))
  const batch = checked && checked.forge === selectedForge ? checked.batch : undefined
  const resultOf = (path: string): RepoAccessResult | undefined =>
    batch?.results.find((result) => result.path === path)
  const verdictsFor = (from: RepoAccessBatch | undefined) =>
    paths.map((path) => ({
      path,
      check: pathCheck(
        from?.results.find((result) => result.path === path),
        {
          added: added.has(path),
          fromUrl: parsed.fromUrl.includes(path),
          ...(from?.account ? { account: from.account } : {}),
        },
      ),
    }))
  const verdicts = verdictsFor(batch)
  const ready = verdicts.filter((verdict) => verdict.check.ready).map((verdict) => verdict.path)
  const unchecked = paths.filter((path) => !added.has(path) && !resultOf(path))
  const tooMany = paths.length > MAX_PATHS

  const teamEntries = teams.data?.entries ?? []
  const multiForge = forgeIds.length > 1
  const patternOf = (path: string) => (multiForge ? `${selectedForge}:${path}` : path)
  const suggested = selectedForge
    ? suggestTeam(ready, selectedForge, repos.data?.repos ?? [], teamEntries)
    : undefined
  const mode = teamEntries.length ? where : 'fleet'
  const chosenTeam = teamEntries.find((entry) => entry.id === (teamId ?? suggested))
  const patterns = ready.map(patternOf)
  const excludedBy = (excludes: readonly string[], exact: (path: string) => string) =>
    selectedForge
      ? ready.flatMap((path) =>
          excludes
            .filter(
              (pattern) => pattern !== exact(path) && patternMatches(pattern, selectedForge, path),
            )
            .map((pattern) => ({ path, pattern, where: 'team' as const })),
        )
      : []
  const blocked = [
    ...(forgeEntry
      ? excludedBy(forgeEntry.data.exclude ?? [], (path) => path).map((entry) => ({
          ...entry,
          where: 'forge' as const,
        }))
      : []),
    ...(mode === 'team' && chosenTeam ? excludedBy(chosenTeam.data.exclude, patternOf) : []),
  ]
  const pending = putTeam.isPending || putForge.isPending
  const saveError = putTeam.error ?? putForge.error

  const runCheck = (then?: (merged: RepoAccessBatch | undefined) => void) => {
    if (!selectedForge || !unchecked.length) {
      then?.(batch)
      return
    }
    const forgeId = selectedForge
    check.mutate(
      { forgeId, paths: unchecked },
      {
        onSuccess: (result) => {
          const merged: RepoAccessBatch = {
            ...(result.account ? { account: result.account } : {}),
            results: [
              ...(batch?.results ?? []).filter(
                (old) => !result.results.some((fresh) => fresh.path === old.path),
              ),
              ...result.results,
            ],
          }
          setChecked({ forge: forgeId, batch: merged })
          then?.(merged)
        },
      },
    )
  }

  const continueToWhere = () =>
    runCheck((merged) => {
      if (verdictsFor(merged).some((verdict) => verdict.check.ready)) setStep(2)
    })

  const save = async () => {
    if (!selectedForge || !ready.length || blocked.length) return
    try {
      if (mode === 'team') {
        if (!chosenTeam) return
        const { title, owns, exclude, consumes, members } = chosenTeam.data
        const next = withPaths({ include: owns, exclude }, patterns)
        await putTeam.mutateAsync({
          id: chosenTeam.id,
          data: {
            ...(title ? { title } : {}),
            owns: next.include,
            exclude: next.exclude,
            consumes,
            members,
          },
        })
      } else {
        if (!forgeEntry) return
        const draft = toForgeDraft(forgeEntry)
        await putForge.mutateAsync({
          id: forgeEntry.id,
          data: toForgeInput({ ...draft, ...withPaths(draft, ready) }),
        })
      }
      notify.success(
        `${plural(ready.length, 'repository', 'repositories')} added`,
        mode === 'team' && chosenTeam
          ? `Owned by team ${titleOf(chosenTeam.id)}`
          : `Fleet of ${selectedForge}`,
      )
      onClose()
    } catch (error) {
      notify.error('Not added', messageOf(error))
    }
  }

  const footer =
    step === 0 ? (
      <>
        <Button variant="tertiary" onPress={onClose}>
          Cancel
        </Button>
        <Button variant="primary" isDisabled={!selectedForge} onPress={() => setStep(1)}>
          Continue to paths
        </Button>
      </>
    ) : step === 1 ? (
      <>
        <Button variant="tertiary" onPress={() => setStep(0)}>
          Back
        </Button>
        <span className="me-auto text-xs text-muted">
          {plural(ready.length, 'path')} of {paths.length} ready
        </span>
        {unchecked.length ? (
          <Button
            variant="secondary"
            isDisabled={tooMany}
            isPending={check.isPending}
            onPress={() => runCheck()}
          >
            Check access
          </Button>
        ) : null}
        <Button
          variant="primary"
          isDisabled={tooMany || (!ready.length && !unchecked.length)}
          isPending={check.isPending}
          onPress={continueToWhere}
        >
          Continue
        </Button>
      </>
    ) : (
      <>
        <Button variant="tertiary" onPress={() => setStep(1)}>
          Back
        </Button>
        <Button
          variant="primary"
          onPress={() => void save()}
          isDisabled={!ready.length || (mode === 'team' && !chosenTeam) || blocked.length > 0}
          isPending={pending}
        >
          Add {plural(ready.length, 'repository', 'repositories')}
        </Button>
      </>
    )

  return (
    <SideSheet
      open
      onClose={onClose}
      title="Add repository"
      progress={{
        segments: steps.map((label, index) => ({
          value: 1,
          tone: index < step ? 'success' : index === step ? 'accent' : 'default',
          label: `${label} ${index < step ? 'done' : index === step ? 'current' : 'to do'}`,
        })),
        label: `Step ${step + 1} of 3 · ${steps[step] ?? ''}`,
      }}
      footer={footer}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Holtkeeper works on the repositories teams own plus the folders a forge includes. You pick
          the owner team, or just the forge's fleet, in the last step.
        </p>
        {forges.isError || teams.isError ? (
          <Notice tone="danger" title="Config is not available">
            {messageOf(forges.error ?? teams.error)}
          </Notice>
        ) : null}
        {step === 0 ? (
          <>
            {forges.isSuccess && forgeIds.length === 0 ? (
              <Notice tone="warning" title="No forge configured">
                <span className="flex flex-col items-start gap-2">
                  Add a forge with its token first.
                  <LinkButton
                    to="/settings/$section"
                    params={{ section: 'integrations' }}
                    size="sm"
                  >
                    Open Integrations
                  </LinkButton>
                </span>
              </Notice>
            ) : null}
            <Select
              label="Forge"
              options={(forges.data?.entries ?? []).map((entry) => ({
                id: entry.id,
                label: (
                  <span className="flex items-baseline gap-2">
                    {entry.id}
                    <span className="mono truncate text-[11px] text-muted">{entry.data.url}</span>
                  </span>
                ),
                text: entry.id,
              }))}
              value={selectedForge}
              onChange={setForge}
              placeholder="Choose a forge"
            />
            <p className="text-xs text-muted">
              Repository on another forge? Add it in{' '}
              <LinkButton
                to="/settings/$section"
                params={{ section: 'integrations' }}
                variant="ghost"
                size="sm"
              >
                Integrations
              </LinkButton>
            </p>
          </>
        ) : null}
        {step === 1 && selectedForge ? (
          <>
            <section aria-labelledby="add-repo-forge" className="flex flex-col gap-1.5">
              <h3 id="add-repo-forge" className="text-xs font-semibold text-muted">
                Forge
              </h3>
              <div className="flex items-center gap-2 text-sm">
                <span className="mono truncate">{forgeEntry?.data.url ?? selectedForge}</span>
                {batch?.account ? (
                  <span className="text-muted">
                    · token <span className="mono">@{batch.account.username}</span>
                  </span>
                ) : null}
                <Button variant="ghost" size="sm" className="ms-auto" onPress={() => setStep(0)}>
                  Change
                </Button>
              </div>
            </section>
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold text-muted">Paths</h3>
              <span className="ms-auto">
                <Segmented
                  aria-label="How to add paths"
                  options={[
                    { id: 'pick', label: 'Pick from forge' },
                    { id: 'paste', label: 'Paste paths' },
                  ]}
                  value={source}
                  onChange={setSource}
                />
              </span>
            </div>
            {source === 'pick' ? (
              <RepoExplorer
                forge={selectedForge}
                selected={picked}
                added={added}
                onToggle={(path) => {
                  setRemoved((list) => list.filter((entry) => entry !== path))
                  setPicked((list) =>
                    list.includes(path) ? list.filter((entry) => entry !== path) : [...list, path],
                  )
                }}
              />
            ) : (
              <TextField
                label="Paths or forge URLs, one per line"
                value={pasted}
                onChange={(value) => {
                  setRemoved([])
                  setPasted(value)
                }}
                multiline
                rows={6}
                mono
                placeholder={'acme/widget-kit\nhttps://gitlab.acme.dev/acme/ledger-api'}
                description="Holtkeeper checks that the token can read each path. URLs are trimmed to their path."
                autoFocus
              />
            )}
            {parsed.invalid.length ? (
              <Notice tone="warning" title={`${plural(parsed.invalid.length, 'line')} skipped`}>
                {parsed.invalid.map((entry) => `${entry.line}: ${entry.error}`).join(' · ')}
              </Notice>
            ) : null}
            {tooMany ? (
              <Notice tone="danger" title={`At most ${MAX_PATHS} paths at once`}>
                Add the rest in a second round.
              </Notice>
            ) : null}
            {check.error ? (
              <Notice tone="danger" title="Access not checked">
                {messageOf(check.error)}
              </Notice>
            ) : null}
            {paths.length ? (
              <PathList
                verdicts={verdicts}
                onRemove={(path) => {
                  setRemoved((list) => [...list, path])
                  setPicked((list) => list.filter((entry) => entry !== path))
                }}
              />
            ) : null}
          </>
        ) : null}
        {step === 2 ? (
          <>
            {saveError ? (
              <Notice tone="danger" title="Not added">
                {messageOf(saveError)}
              </Notice>
            ) : null}
            <p className="text-sm">
              A team that owns {plural(ready.length, 'the repository', 'the repositories')} answers
              for them; the forge's fleet list adds them without an owner.
              {suggested ? (
                <span className="text-muted">
                  {' '}
                  Suggested by folder: <span className="text-foreground">{titleOf(suggested)}</span>
                </span>
              ) : null}
            </p>
            {teamEntries.length ? (
              <Segmented
                aria-label="Where"
                options={[
                  { id: 'team', label: 'A team owns them' },
                  { id: 'fleet', label: 'Forge fleet only' },
                ]}
                value={where}
                onChange={setWhere}
              />
            ) : null}
            {mode === 'team' ? (
              <Select
                label="Team"
                options={teamEntries.map((entry) => ({
                  id: entry.id,
                  label: (
                    <span className="flex items-baseline gap-2">
                      {titleOf(entry.id)}
                      <span className="truncate font-mono text-[11px] text-muted">
                        {[titleOf(entry.id) === entry.id ? undefined : entry.id, ...entry.data.owns]
                          .filter(Boolean)
                          .join(', ')}
                      </span>
                    </span>
                  ),
                  text: titleOf(entry.id),
                }))}
                value={chosenTeam?.id}
                onChange={setTeamId}
                placeholder="Choose a team"
              />
            ) : null}
            {mode === 'team' ? (
              <p className="text-xs text-muted">Its owns list gets the exact paths.</p>
            ) : (
              <p className="text-xs text-muted">
                The include list of <span className="mono">{selectedForge}</span> gets the exact
                paths. Give them an owner later on the Teams page.
              </p>
            )}
            {blocked.length ? (
              <Notice tone="danger" title="Excluded by a pattern">
                <ul className="flex flex-col gap-0.5">
                  {blocked.map(({ path, pattern, where: owner }) => (
                    <li key={`${owner}:${path}:${pattern}`}>
                      <span className="mono">{path}</span> is excluded by{' '}
                      {owner === 'forge' ? 'the forge' : 'the team'} pattern{' '}
                      <span className="mono">{pattern}</span>. Edit that pattern first.
                    </li>
                  ))}
                </ul>
              </Notice>
            ) : null}
            <ul className="flex flex-wrap gap-1.5" aria-label="Repositories to add">
              {ready.map((path) => (
                <li key={path} className="mono rounded-md border border-line px-1.5 text-xs">
                  {path}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </SideSheet>
  )
}

const tally = (verdicts: readonly { check: PathCheck }[]) => {
  const counts = new Map<string, { label: string; tone: PathCheck['tone']; count: number }>()
  for (const { check } of verdicts) {
    const entry = counts.get(check.label) ?? { label: check.label, tone: check.tone, count: 0 }
    entry.count += 1
    counts.set(check.label, entry)
  }
  return [...counts.values()]
}

function PathList({
  verdicts,
  onRemove,
}: {
  verdicts: readonly { path: string; check: PathCheck }[]
  onRemove: (path: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted" aria-label="Check summary">
        <li>
          <b className="text-foreground">{verdicts.length}</b> to add
        </li>
        {tally(verdicts).map((entry) => (
          <li key={entry.label} className="inline-flex items-center gap-1.5">
            <Dot tone={entry.tone} />
            <b className="text-foreground">{entry.count}</b> {entry.label.toLowerCase()}
          </li>
        ))}
      </ul>
      <ul
        aria-label="Access check per path"
        className="flex max-h-64 flex-col divide-y divide-line overflow-y-auto rounded-xl border border-line"
      >
        {verdicts.map(({ path, check }) => (
          <li key={path} className="flex items-center gap-3 px-3 py-2">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Dot tone={check.tone} />
                <span className="mono truncate text-[12.5px]">{path}</span>
              </span>
              <span className="truncate ps-3 text-[11px] text-dim">{check.why}</span>
            </div>
            <span className="shrink-0 text-xs font-medium">{check.label}</span>
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              aria-label={`Remove ${path}`}
              onPress={() => onRemove(path)}
            >
              <X className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The team that owns most listed repositories in the folders of the new paths, nearest folder
 * first; `undefined` when no sibling has an owner.
 */
function suggestTeam(
  paths: readonly string[],
  forge: string,
  repos: readonly { repo: { forge: string; path: string }; teams: readonly string[] }[],
  teams: readonly { id: string }[],
): string | undefined {
  const known = new Set(teams.map((entry) => entry.id))
  const votes = new Map<string, number>()
  for (const path of paths) {
    const folder = parentFolder(path)
    if (folder === undefined) continue
    for (const summary of repos)
      if (summary.repo.forge === forge && parentFolder(summary.repo.path) === folder)
        for (const team of summary.teams)
          if (known.has(team)) votes.set(team, (votes.get(team) ?? 0) + 1)
  }
  return [...votes].toSorted((a, b) => b[1] - a[1])[0]?.[0]
}
