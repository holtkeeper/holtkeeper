import { Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '../../ui/index.ts'
import { FormSection } from './shared.tsx'

/**
 * The linear form of the rule drawer: When / Where / If / Then / Limits, then a footer pinned to
 * the bottom of the sheet with Remove (stored rules), an unsaved-changes note, Discard and Save.
 * Sections left `undefined` are not shown; without `writable` nothing saves.
 */
export function RuleForm({
  when,
  where,
  condition,
  then,
  limits,
  notice,
  writable,
  isPending,
  dirty = false,
  onSave,
  onDiscard,
  onRemove,
}: {
  when: ReactNode
  where: ReactNode
  condition?: ReactNode
  then: ReactNode
  limits?: ReactNode
  notice?: ReactNode
  writable: boolean
  isPending: boolean
  /** The draft differs from what is stored. */
  dirty?: boolean
  onSave: () => void
  onDiscard?: () => void
  onRemove?: () => void
}) {
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        if (writable) onSave()
      }}
    >
      {notice}
      <fieldset disabled={!writable} className="flex flex-col gap-5">
        <FormSection title="When">{when}</FormSection>
        <FormSection title="Where">{where}</FormSection>
        {condition !== undefined ? <FormSection title="If">{condition}</FormSection> : null}
        <FormSection title="Then">{then}</FormSection>
        {limits !== undefined ? <FormSection title="Limits">{limits}</FormSection> : null}
      </fieldset>
      <div className="sticky bottom-0 z-[3] -mx-4 -mb-4 flex items-center gap-2 border-t border-line bg-panel px-4 py-3">
        {writable && onRemove ? (
          <Button variant="ghost" size="sm" onPress={onRemove}>
            <Trash2 className="size-3.5" />
            Remove
          </Button>
        ) : null}
        {writable ? (
          <>
            <span className="ml-auto text-xs text-muted">{dirty ? 'Unsaved changes' : null}</span>
            {dirty && onDiscard ? (
              <Button size="sm" onPress={onDiscard}>
                Discard
              </Button>
            ) : null}
            <Button type="submit" variant="primary" size="sm" isPending={isPending}>
              Save rule
            </Button>
          </>
        ) : (
          <span className="ml-auto text-xs text-muted">
            Read only: editing needs settings:write.
          </span>
        )}
      </div>
    </form>
  )
}
