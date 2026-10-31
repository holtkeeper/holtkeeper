import type { RepoRef, ReportExclude } from '@holtkeeper/api'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useResolvedSettings, useSettingMutations } from '../../api/queries.ts'
import { excludeChoices, excludeEntry } from '../../lib/exclude.ts'
import { repoKey } from '../../lib/repo.ts'
import { Button, Dialog, Notice, Segmented, Select, TextField, notify } from '../../ui/index.ts'

/**
 * Adds a glob for `path` to a list option of the report's analyzer setting for `repo`: the file,
 * its folder or a hand-written pattern. Applies from the next run.
 */
export function ExcludeDialog({
  path,
  repo,
  exclude,
  onClose,
}: {
  path: string
  repo: RepoRef
  exclude: ReportExclude
  onClose: () => void
}) {
  const choices = excludeChoices(path)
  const [option, setOption] = useState(exclude.options[0]?.option ?? '')
  const [pattern, setPattern] = useState(choices[0]?.pattern ?? path)
  const resolved = useResolvedSettings(repo)
  const { put } = useSettingMutations()
  const chosen = exclude.options.find((entry) => entry.option === option)
  const preset = choices.find((choice) => choice.pattern === pattern)?.pattern

  const save = () => {
    const entry = excludeEntry(
      exclude.setting,
      option,
      pattern.trim(),
      repo,
      resolved.data?.settings[exclude.setting],
    )
    put.mutate(entry, {
      onSuccess: () => {
        notify.success(
          `Added ${pattern.trim()}`,
          `${exclude.setting} → ${option}; applies from the next run`,
        )
        onClose()
      },
      onError: (error) => notify.error('Could not save the pattern', messageOf(error)),
    })
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Exclude from later runs"
      description={<span className="break-all font-mono text-xs">{path}</span>}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button
            onPress={save}
            isPending={put.isPending}
            isDisabled={!pattern.trim() || !option || resolved.isPending}
          >
            Add pattern
          </Button>
        </>
      }
    >
      {exclude.options.length > 1 ? (
        <div className="flex flex-col gap-1.5">
          <Segmented
            aria-label="How to exclude"
            options={exclude.options.map((entry) => ({ id: entry.option, label: entry.label }))}
            value={option}
            onChange={setOption}
          />
          {chosen?.description ? <p className="text-xs text-muted">{chosen.description}</p> : null}
        </div>
      ) : null}
      <Select
        label="Pattern"
        options={choices.map((choice) => ({
          id: choice.pattern,
          text: choice.label,
          label: (
            <span className="flex min-w-0 flex-col">
              <span>{choice.label}</span>
              <span className="truncate font-mono text-[11px] text-muted">{choice.pattern}</span>
            </span>
          ),
        }))}
        value={preset}
        placeholder="Custom pattern"
        onChange={setPattern}
      />
      <TextField
        label="Glob"
        value={pattern}
        onChange={setPattern}
        mono
        description={'Relative to the repository root; \\ escapes [ ] { } * ? !'}
      />
      {resolved.isError ? (
        <Notice tone="danger" title="Settings unavailable">
          {messageOf(resolved.error)}
        </Notice>
      ) : null}
      <p className="text-xs text-muted">
        Saved to <span className="font-mono">{exclude.setting}</span> for{' '}
        <span className="font-mono">{repoKey(repo)}</span>.
      </p>
    </Dialog>
  )
}
