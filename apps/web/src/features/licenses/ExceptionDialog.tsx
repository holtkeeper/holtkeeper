import type { LicenseViolation, SettingView } from '@holtkeeper/api'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useDescribeScope,
  useResolvedRepos,
  useSettingMutations,
  useSettings,
} from '../../api/queries.ts'
import { isoDay, plural } from '../../lib/format.ts'
import { exceptionTargets, violationLicense, withLicenseException } from '../../lib/licenses.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { inDays, isFutureDay } from '../../lib/security.ts'
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
 * Adds a license exception for a violating package: optionally limited to its license, with a
 * reason and a last day. The exception goes into the `analyzers.licenses` entry the resolver says
 * applies to the package's repositories, kept whole, or into a new entry scoped to repositories on
 * the defaults. Repositories whose applying entry the caller cannot read are left out and named.
 */
export function ExceptionDialog({
  violation,
  onClose,
}: {
  violation: LicenseViolation
  onClose: () => void
}) {
  const describeScope = useDescribeScope()
  const { principal } = useSession()
  const settings = useSettings()
  const { put } = useSettingMutations()
  const keys = violation.repos.map((entry) => entry.repo)
  const refs = keys.flatMap((key) => parseRepoKey(key) ?? [])
  const resolved = useResolvedRepos(refs)
  const winners = new Map<string, SettingView | null>()
  resolved.forEach((query, index) => {
    const ref = refs[index]
    if (ref && query.data)
      winners.set(repoKey(ref), query.data.settings['analyzers.licenses'] ?? null)
  })
  const resolving = resolved.some((query) => query.isPending)
  const { targets, blocked } = settings.data
    ? exceptionTargets(keys, winners, settings.data.settings)
    : { targets: [], blocked: [] }
  const license = violationLicense(violation)
  const [target, setTarget] = useState(0)
  const [reason, setReason] = useState('')
  const [expires, setExpires] = useState(() => inDays(90))
  const [onlyLicense, setOnlyLicense] = useState(violation.licenses.length > 0)
  const chosen = targets[target]
  const validDay = isFutureDay(expires, isoDay(new Date()))
  const valid = chosen !== undefined && reason.trim() !== '' && validDay

  const save = () => {
    if (!chosen) return
    put.mutate(
      {
        ...(chosen.settingId ? { id: chosen.settingId } : {}),
        key: 'analyzers.licenses',
        scope: chosen.scope,
        value: withLicenseException(chosen.value, {
          package: violation.package,
          ...(onlyLicense && violation.licenses[0] ? { license: violation.licenses[0] } : {}),
          reason: reason.trim(),
          approvedBy: principal.name,
          expires,
        }),
      },
      {
        onSuccess: () => {
          notify.success('Exception added', `${violation.package} until ${expires}`)
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
      title={`Add an exception for ${violation.package}`}
      description="License scans accept the package until the last day. The change is audited."
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" isDisabled={!valid || put.isPending} onPress={save}>
            Add exception
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
              The license policy that applies in {blocked.join(', ')} is outside your settings
              access. Ask an admin to add the exception there.
            </Notice>
          ) : null}
          <Select
            label="Add to"
            options={targets.map((entry, index) => ({
              id: String(index),
              label: `${entry.settingId ? 'Policy for' : 'New policy for'} ${describeScope(entry.scope)} · applies in ${plural(entry.reaches.length, 'repository', 'repositories')}`,
            }))}
            value={String(target)}
            onChange={(id) => setTarget(Number(id))}
          />
          {violation.licenses.length ? (
            <Checkbox
              isSelected={onlyLicense}
              onChange={setOnlyLicense}
              label={
                <>
                  Only under <span className="mono">{license}</span>
                </>
              }
            />
          ) : null}
          <TextField
            label="Reason"
            value={reason}
            onChange={setReason}
            multiline
            rows={3}
            placeholder="Why the package may stay, for reviewers to check"
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
