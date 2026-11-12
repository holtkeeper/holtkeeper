import type { FindingGroup, SettingView } from '@holtkeeper/api'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useDescribeScope,
  useResolvedRepos,
  useSettingMutations,
  useSettings,
} from '../../api/queries.ts'
import { isoDay, plural } from '../../lib/format.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { allowlistTargets, inDays, isFutureDay, withAllowlistEntry } from '../../lib/security.ts'
import {
  Button,
  Checkbox,
  Dialog,
  ErrorState,
  Notice,
  Placeholder,
  Select,
  TextField,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

/**
 * Adds an `audit.allowlist` entry for a finding group: advisory, optionally limited to the
 * package, a reason and a last day. It goes into the setting entry the resolver says applies to
 * the affected repositories, or into a new entry scoped to the repositories no entry covers yet.
 * Repositories whose applying entry the caller cannot read are left out and named, since a
 * narrower entry would replace that list.
 */
export function AllowlistDialog({ group, onClose }: { group: FindingGroup; onClose: () => void }) {
  const describeScope = useDescribeScope()
  const { principal } = useSession()
  const settings = useSettings()
  const { put } = useSettingMutations()
  const client = useQueryClient()
  const pending = group.repos.filter((repo) => repo.status !== 'allowlisted')
  const keys = (pending.length ? pending : group.repos).map((repo) => repo.repo)
  const refs = keys.flatMap((key) => parseRepoKey(key) ?? [])
  const resolved = useResolvedRepos(refs)
  const winners = new Map<string, SettingView | null>()
  resolved.forEach((query, index) => {
    const ref = refs[index]
    if (ref && query.data) winners.set(repoKey(ref), query.data.settings['audit.allowlist'] ?? null)
  })
  const resolving = resolved.some((query) => query.isPending)
  const { targets, blocked } = settings.data
    ? allowlistTargets(keys, winners, settings.data.settings)
    : { targets: [], blocked: [] }
  const [target, setTarget] = useState(0)
  const [reason, setReason] = useState('')
  const [expires, setExpires] = useState(() => inDays(90))
  const [onlyPackage, setOnlyPackage] = useState(true)
  const today = isoDay(new Date())
  const chosen = targets[target]
  const validDay = isFutureDay(expires, today)
  const valid = chosen !== undefined && reason.trim() !== '' && validDay

  const save = () => {
    if (!chosen) return
    put.mutate(
      {
        ...(chosen.settingId ? { id: chosen.settingId } : {}),
        key: 'audit.allowlist',
        scope: chosen.scope,
        value: withAllowlistEntry(chosen.entries, {
          id: group.advisory,
          reason: reason.trim(),
          expires,
          author: principal.name,
          ...(onlyPackage ? { package: group.package } : {}),
        }),
      },
      {
        onSuccess: () => {
          void client.invalidateQueries({ queryKey: ['audit-runs'] })
          notify.success('Allowlisted', `${group.advisory} until ${expires}`)
          onClose()
        },
        onError: (error) => notify.error('Not saved', messageOf(error)),
      },
    )
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={`Allowlist ${group.advisory}`}
      description="Audits stop counting the finding until the last day. The change is audited."
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" isDisabled={!valid || put.isPending} onPress={save}>
            Allowlist
          </Button>
        </>
      }
    >
      {settings.isPending || resolving ? (
        <Placeholder className="h-32" />
      ) : settings.isError ? (
        <ErrorState error={settings.error} />
      ) : (
        <>
          {blocked.length ? (
            <Notice
              tone="warning"
              title={`Left out ${plural(blocked.length, 'repository', 'repositories')}`}
            >
              The allowlist that applies in {blocked.join(', ')} is outside your settings access,
              and a narrower entry would replace it. Ask an admin to allowlist the finding there.
            </Notice>
          ) : null}
          <Select
            label="Add to"
            options={targets.map((entry, index) => ({
              id: String(index),
              label: `${entry.settingId ? 'Entry for' : 'New entry for'} ${describeScope(entry.scope)} · applies in ${plural(entry.reaches.length, 'repository', 'repositories')}`,
            }))}
            value={String(target)}
            onChange={(id) => setTarget(Number(id))}
          />
          <Checkbox
            isSelected={onlyPackage}
            onChange={setOnlyPackage}
            label={
              <>
                Only for <span className="mono">{group.package}</span>
              </>
            }
          />
          <TextField
            label="Reason"
            value={reason}
            onChange={setReason}
            multiline
            rows={3}
            placeholder="Why the finding does not matter here, for reviewers to check"
            isRequired
          />
          <TextField
            label="Last day"
            type="date"
            value={expires}
            onChange={setExpires}
            {...(validDay ? {} : { error: 'Pick a day from today on' })}
          />
        </>
      )}
    </Dialog>
  )
}
