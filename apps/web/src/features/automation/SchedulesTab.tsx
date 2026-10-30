import type { ConfigEntryView } from '@holtkeeper/api'
import { CalendarClock, Pencil, Plus, Trash2, Undo2 } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useConfigEntries, useConfigMutations } from '../../api/queries.ts'
import { describeCadence, describeWindows } from '../../lib/automation.ts'
import { formatGroupMatch } from '../../lib/scope.ts'
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Panel,
  Placeholder,
  Switch,
  Table,
  Td,
  Th,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { ScheduleDialog } from './ScheduleDialog.tsx'
import { ChipList, NextRuns, ProvenanceChip, RemoveEntryDialog, UpdatedLine } from './shared.tsx'

type ScheduleEntry = ConfigEntryView<'schedule'>

/** Schedules of the effective config with their cadence, targets and next runs. */
export function SchedulesTab() {
  const { can } = useSession()
  const writable = can('settings:write')
  const schedules = useConfigEntries('schedules')
  const { put } = useConfigMutations('schedules')
  const [editing, setEditing] = useState<ScheduleEntry | 'new' | null>(null)
  const [removing, setRemoving] = useState<ScheduleEntry | null>(null)
  const list = schedules.data?.entries ?? []

  const toggle = (entry: ScheduleEntry, enabled: boolean) =>
    put.mutate(
      { id: entry.id, data: { ...entry.data, enabled } },
      {
        onSuccess: () => notify.success(enabled ? 'Schedule on' : 'Schedule off', entry.data.name),
        onError: (error) => notify.error('Not changed', messageOf(error)),
      },
    )

  return (
    <Panel
      title="Schedules"
      description="Analyzers queued on a timetable. Panel schedules replace file schedules of the same id; switching a file schedule off keeps it in the file but stops its runs."
      actions={
        writable ? (
          <Button variant="secondary" size="sm" onPress={() => setEditing('new')}>
            <Plus className="size-4" />
            Add schedule
          </Button>
        ) : null
      }
    >
      {schedules.isPending ? (
        <Placeholder className="h-32" />
      ) : schedules.isError ? (
        <ErrorState error={schedules.error} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<CalendarClock />}
          title="No schedules"
          description="Add one to run analyzers every night, every hour during office hours or on any cron."
        />
      ) : (
        <Table label="Schedules">
          <thead>
            <tr>
              <Th>Schedule</Th>
              <Th>Cadence</Th>
              <Th>Analyzers</Th>
              <Th>Targets</Th>
              <Th>Next runs</Th>
              <Th>On</Th>
              {writable ? <Th /> : null}
            </tr>
          </thead>
          <tbody>
            {list.map((entry) => {
              const windows = describeWindows(entry.data.windows)
              return (
                <tr key={entry.id}>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {entry.data.name}
                        <ProvenanceChip provenance={entry.provenance} />
                      </span>
                      {entry.data.name !== entry.id ? (
                        <span className="font-mono text-xs text-muted">{entry.id}</span>
                      ) : null}
                      <UpdatedLine entry={entry} />
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <span className="whitespace-nowrap">{describeCadence(entry.data)}</span>
                      {windows.length || entry.data.timezone ? (
                        <span className="text-xs text-muted">
                          {[...windows, ...(entry.data.timezone ? [entry.data.timezone] : [])].join(
                            ' · ',
                          )}
                        </span>
                      ) : null}
                      {entry.data.jitterMinutes || entry.data.spread ? (
                        <span className="flex flex-wrap gap-1">
                          {entry.data.jitterMinutes ? (
                            <Chip>±{entry.data.jitterMinutes} min</Chip>
                          ) : null}
                          {entry.data.spread ? <Chip>spread</Chip> : null}
                        </span>
                      ) : null}
                    </div>
                  </Td>
                  <Td>
                    <ChipList values={entry.data.analyzers} />
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-1 text-sm">
                      <span>
                        {entry.data.groups?.length ? (
                          entry.data.groups.map(formatGroupMatch).join(', ')
                        ) : (
                          <span className="text-muted">All groups</span>
                        )}
                      </span>
                      {entry.data.repos?.length ? (
                        <span className="font-mono text-xs text-muted">
                          {entry.data.repos.join(', ')}
                        </span>
                      ) : null}
                    </div>
                  </Td>
                  <Td>
                    {entry.data.enabled ? (
                      <NextRuns id={entry.id} />
                    ) : (
                      <span className="text-sm text-muted">Off</span>
                    )}
                  </Td>
                  <Td>
                    <Switch
                      label={<span className="sr-only">Enabled</span>}
                      isSelected={entry.data.enabled}
                      isDisabled={!writable || put.isPending}
                      onChange={(enabled) => toggle(entry, enabled)}
                    />
                  </Td>
                  {writable ? (
                    <Td align="right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          isIconOnly
                          aria-label={`Edit ${entry.id}`}
                          onPress={() => setEditing(entry)}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        {entry.provenance !== 'file' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            isIconOnly
                            aria-label={
                              entry.provenance === 'file+panel'
                                ? `Revert ${entry.id} to the config file`
                                : `Delete ${entry.id}`
                            }
                            onPress={() => setRemoving(entry)}
                          >
                            {entry.provenance === 'file+panel' ? (
                              <Undo2 className="size-3.5" />
                            ) : (
                              <Trash2 className="size-3.5" />
                            )}
                          </Button>
                        ) : null}
                      </div>
                    </Td>
                  ) : null}
                </tr>
              )
            })}
          </tbody>
        </Table>
      )}

      {editing ? (
        <ScheduleDialog
          key={editing === 'new' ? 'new' : editing.id}
          {...(editing === 'new' ? {} : { entry: editing })}
          taken={list.map((entry) => entry.id)}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <RemoveEntryDialog
        collection="schedules"
        entry={removing}
        noun="schedule"
        onClose={() => setRemoving(null)}
      />
    </Panel>
  )
}
