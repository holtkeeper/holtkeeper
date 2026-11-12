import type { RepoAccessBatch, RepoAccessResult } from '@holtkeeper/api'
import { X } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useCheckRepoAccess,
  useForges,
  useGroups,
  usePutGroup,
  useRepos,
} from '../../api/queries.ts'
import { plural } from '../../lib/format.ts'
import {
  type PathCheck,
  parsePastedPaths,
  pathCheck,
  validateGroupId,
  withRepos,
} from '../../lib/repo.ts'
import { suggestGroup } from '../../lib/repos.ts'
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
import { RepoExplorer } from './RepoExplorer.tsx'

/** Paths one access check takes. */
const MAX_PATHS = 50

const steps = ['Forge', 'Paths', 'Group'] as const

/**
 * Adds repositories in three steps: a forge, then paths (picked from the token's projects or
 * pasted, URLs trimmed) checked against the forge token in one batch, then a group, existing or
 * new, whose include list gets the exact paths. Settings, schedules and access follow the group.
 * Opens as a side sheet beside the list. Needs global `settings:write`.
 */
export function AddRepoDialog({ onClose }: { onClose: () => void }) {
  const forges = useForges()
  const groups = useGroups()
  const repos = useRepos()
  const put = usePutGroup()
  const check = useCheckRepoAccess()
  const forgeIds = (forges.data?.entries ?? []).map((entry) => entry.id)
  const [step, setStep] = useState(0)
  const [forge, setForge] = useState<string>()
  const [source, setSource] = useState<'pick' | 'paste'>('pick')
  const [picked, setPicked] = useState<string[]>([])
  const [pasted, setPasted] = useState('')
  const [removed, setRemoved] = useState<string[]>([])
  const [checked, setChecked] = useState<{ forge: string; batch: RepoAccessBatch }>()
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [groupId, setGroupId] = useState<string>()
  const [newGroup, setNewGroup] = useState('')

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

  const forgeGroups = (groups.data?.entries ?? []).filter(
    (entry) => entry.data.forge === selectedForge,
  )
  const suggested = suggestGroup(ready, forgeGroups)
  const groupMode = forgeGroups.length ? mode : 'new'
  const chosenGroup = groupId ?? suggested
  const target = groupMode === 'existing' ? chosenGroup : newGroup.trim()
  const existing = forgeGroups.find((entry) => entry.id === target)
  const groupError =
    groupMode === 'new' && newGroup
      ? (validateGroupId(newGroup) ??
        ((groups.data?.entries ?? []).some((entry) => entry.id === newGroup.trim())
          ? 'A group with this id exists'
          : undefined))
      : undefined

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

  const continueToGroup = () =>
    runCheck((merged) => {
      if (verdictsFor(merged).some((verdict) => verdict.check.ready)) setStep(2)
    })

  const save = () => {
    if (!selectedForge || !target || !ready.length) return
    put.mutate(
      { id: target, data: withRepos(existing?.data, selectedForge, ready) },
      {
        onSuccess: () => {
          notify.success(
            `${plural(ready.length, 'repository', 'repositories')} added`,
            `Group ${target} on ${selectedForge}`,
          )
          onClose()
        },
      },
    )
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
          onPress={continueToGroup}
        >
          Continue to group
        </Button>
      </>
    ) : (
      <>
        <Button variant="tertiary" onPress={() => setStep(1)}>
          Back
        </Button>
        <Button
          variant="primary"
          onPress={save}
          isDisabled={!target || !ready.length || groupError !== undefined}
          isPending={put.isPending}
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
          Holtkeeper works on repositories through groups: settings, schedules and access follow the
          group. You pick the group in the last step.
        </p>
        {forges.isError || groups.isError ? (
          <Notice tone="danger" title="Config is not available">
            {messageOf(forges.error ?? groups.error)}
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
            {put.error ? (
              <Notice tone="danger" title="Not added">
                {messageOf(put.error)}
              </Notice>
            ) : null}
            <p className="text-sm">
              {plural(ready.length, 'repository', 'repositories')} go to one group, or to a new one.
              {suggested ? (
                <span className="text-muted">
                  {' '}
                  Suggested by name: <span className="mono text-foreground">{suggested}</span>
                </span>
              ) : null}
            </p>
            {forgeGroups.length ? (
              <Segmented
                aria-label="Group"
                options={[
                  { id: 'existing', label: 'Existing group' },
                  { id: 'new', label: 'New group' },
                ]}
                value={mode}
                onChange={setMode}
              />
            ) : null}
            {groupMode === 'existing' ? (
              <Select
                label="Group"
                options={forgeGroups.map((entry) => ({
                  id: entry.id,
                  label: (
                    <span className="flex items-baseline gap-2">
                      {entry.id}
                      <span className="truncate font-mono text-[11px] text-muted">
                        {entry.data.include.join(', ')}
                      </span>
                    </span>
                  ),
                  text: entry.id,
                }))}
                value={chosenGroup}
                onChange={setGroupId}
                placeholder="Choose a group"
              />
            ) : (
              <TextField
                label="New group id"
                value={newGroup}
                onChange={setNewGroup}
                placeholder="e.g. payments"
                mono
                error={groupError}
              />
            )}
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
