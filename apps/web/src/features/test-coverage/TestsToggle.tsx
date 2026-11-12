import type { RepoCoverageTests, RepoRef } from '@holtkeeper/api'
import { FlaskConicalOff } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useDescribeScope, useSettingMutations } from '../../api/queries.ts'
import { testsEntryValue, testsToggle } from '../../lib/coverage.ts'
import { repoKey } from '../../lib/repo.ts'
import { Button, Dialog, Notice, TextField, notify } from '../../ui/index.ts'
import type { MoreMenuItem } from '../../ui/MoreMenu.tsx'

const testsKey = 'repo.tests'

/**
 * The `repo.tests` quick toggle of one repository for callers with `settings:write`
 * (`tests.configurable`): `markItem` (a menu entry opening a dialog that asks for the reason)
 * while tests are expected, `expectAgain` while they are not, and the dialog to render.
 */
export function useTestsToggle(repo: RepoRef | undefined, tests: RepoCoverageTests | undefined) {
  const { put, remove } = useSettingMutations()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const toggle = testsToggle(tests)
  const scope = repo ? { repos: [repoKey(repo)] } : undefined
  const own = toggle?.kind !== 'remove' && toggle?.entryId ? { id: toggle.entryId } : {}
  const overrides =
    toggle?.kind === 'override' &&
    toggle.overrides &&
    JSON.stringify(toggle.overrides) !== JSON.stringify(scope)
      ? toggle.overrides
      : undefined

  const mark = () => {
    if (!scope) return
    put.mutate(
      { ...own, key: testsKey, scope, value: testsEntryValue(false, reason) },
      {
        onSuccess: () => {
          setOpen(false)
          setReason('')
          notify.success('Marked as no tests by design', 'Coverage is no longer queued for it')
        },
        onError: (error) => notify.error('Could not change the setting', messageOf(error)),
      },
    )
  }

  const expectAgain = () => {
    if (!scope || !toggle || toggle.kind === 'mark') return
    const done = {
      onSuccess: () => notify.success('Tests are expected again'),
      onError: (error: unknown) => notify.error('Could not change the setting', messageOf(error)),
    }
    if (toggle.kind === 'remove') remove.mutate(toggle.entryId, done)
    else put.mutate({ ...own, key: testsKey, scope, value: testsEntryValue(true) }, done)
  }

  const markItem: MoreMenuItem | undefined =
    toggle?.kind === 'mark'
      ? {
          label: 'Mark as no tests by design…',
          icon: FlaskConicalOff,
          onAction: () => setOpen(true),
        }
      : undefined

  return {
    toggle,
    overrides,
    markItem,
    openMark: () => setOpen(true),
    expectAgain,
    isPending: put.isPending || remove.isPending,
    dialog: (
      <Dialog
        isOpen={open}
        onOpenChange={setOpen}
        title="No tests by design"
        description="Coverage is no longer queued for this repository, and agents neither write nor ask for tests."
        size="sm"
        footer={
          <>
            <Button variant="tertiary" onPress={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onPress={mark} isPending={put.isPending} autoFocus>
              Mark
            </Button>
          </>
        }
      >
        <TextField
          label="Reason"
          value={reason}
          onChange={setReason}
          placeholder="Configuration only"
          description="Shown wherever the repository reads “No tests by design”."
        />
      </Dialog>
    ),
  }
}

/**
 * "No tests by design" with the reason and the scope that decided it, plus "Expect tests again"
 * for callers who may change it: it removes the repository's own entry when that brings tests
 * back, or turns them on in that entry (adding it when missing) over a broader one.
 */
export function NoTestsNotice({
  tests,
  control,
}: {
  tests: RepoCoverageTests
  control: ReturnType<typeof useTestsToggle>
}) {
  const { toggle } = control
  const describeScope = useDescribeScope()
  const from = tests.scope ? describeScope(tests.scope) : undefined
  const overrides = control.overrides ? describeScope(control.overrides) : undefined
  return (
    <Notice title="No tests by design">
      <span className="flex flex-col items-start gap-2">
        <span>
          {[tests.reason, from && `set for ${from}`].filter(Boolean).join(' · ') ||
            'Coverage is not measured for this repository.'}
        </span>
        {toggle && toggle.kind !== 'mark' ? (
          <Button
            variant="secondary"
            size="sm"
            onPress={control.expectAgain}
            isPending={control.isPending}
          >
            {overrides ? `Expect tests again (overrides ${overrides})` : 'Expect tests again'}
          </Button>
        ) : null}
      </span>
    </Notice>
  )
}
