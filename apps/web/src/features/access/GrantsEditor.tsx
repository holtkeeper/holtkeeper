import type { Action, Grant } from '@holtkeeper/api'
import { Plus, Trash2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'

import { actions } from '../../lib/access.ts'
import { Button, Checkbox } from '../../ui/index.ts'
import { ScopeEditor } from './ScopeEditor.tsx'

const areas = [...new Set(actions.map((action) => action.split(':')[0]!))]

/** Edits a list of grants: each a scope plus the actions allowed in it. */
export function GrantsEditor({
  value,
  onChange,
  groups,
}: {
  value: readonly Grant[]
  onChange: (grants: Grant[]) => void
  groups?: readonly string[]
}) {
  const update = (index: number, grant: Grant) =>
    onChange(value.map((g, i) => (i === index ? grant : g)))

  return (
    <div className="flex flex-col gap-3">
      <AnimatePresence initial={false}>
        {value.map((grant, index) => {
          const all = grant.actions.includes('*')
          const toggle = (action: Action, on: boolean) =>
            update(index, {
              ...grant,
              actions: on
                ? [...grant.actions.filter((a) => a !== '*'), action]
                : grant.actions.filter((a) => a !== action),
            })
          return (
            <motion.div
              key={index}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, height: 0 }}
              className="flex flex-col gap-4 rounded-2xl border border-border p-4"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">Grant {index + 1}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  aria-label={`Remove grant ${index + 1}`}
                  onPress={() => onChange(value.filter((_, i) => i !== index))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              <ScopeEditor
                value={grant.scope}
                onChange={(scope) => update(index, { ...grant, scope })}
                groups={groups ?? []}
              />
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-sm font-medium">Actions</legend>
                <Checkbox
                  label={<span className="font-medium">All actions (*)</span>}
                  isSelected={all}
                  onChange={(on) => update(index, { ...grant, actions: on ? ['*'] : [] })}
                />
                <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  {areas.map((area) => (
                    <div key={area} className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium uppercase tracking-wide text-muted">
                        {area}
                      </span>
                      {actions
                        .filter((action) => action.startsWith(`${area}:`))
                        .map((action) => (
                          <Checkbox
                            key={action}
                            label={<span className="font-mono text-xs">{action}</span>}
                            isSelected={all || grant.actions.includes(action)}
                            isDisabled={all}
                            onChange={(on) => toggle(action, on)}
                          />
                        ))}
                    </div>
                  ))}
                </div>
              </fieldset>
            </motion.div>
          )
        })}
      </AnimatePresence>
      <Button
        variant="secondary"
        onPress={() =>
          onChange([...value, { scope: { all: true }, actions: ['repos:read', 'audits:read'] }])
        }
      >
        <Plus className="size-4" />
        Add grant
      </Button>
    </div>
  )
}
