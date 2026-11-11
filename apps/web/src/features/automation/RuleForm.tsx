import { Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '../../ui/index.ts'
import { FormSection } from './shared.tsx'

/**
 * The linear form of the rule drawer: When / Where / If / Then / Limits, then Save and, for a
 * stored rule, Remove. Sections left `undefined` are not shown; without `writable` nothing saves.
 */
export function RuleForm({
  when,
  where,
  condition,
  then,
  limits,
  notice,
  footer,
  writable,
  isPending,
  onSave,
  onRemove,
}: {
  when: ReactNode
  where: ReactNode
  condition?: ReactNode
  then: ReactNode
  limits?: ReactNode
  notice?: ReactNode
  /** Extra controls before Save, e.g. Run now. */
  footer?: ReactNode
  writable: boolean
  isPending: boolean
  onSave: () => void
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
      <div className="flex items-center gap-2 border-t border-line pt-3">
        {footer}
        {writable && onRemove ? (
          <Button variant="ghost" size="sm" onPress={onRemove}>
            <Trash2 className="size-3.5" />
            Remove
          </Button>
        ) : null}
        {writable ? (
          <Button type="submit" variant="primary" className="ml-auto" isPending={isPending}>
            Save
          </Button>
        ) : (
          <span className="ml-auto text-xs text-muted">
            Read only: editing needs settings:write.
          </span>
        )}
      </div>
    </form>
  )
}
