import { useState } from 'react'

import { useSecretReportsLicense } from '../../api/queries.ts'
import { Button, Dialog, ErrorState, Placeholder } from '../../ui/index.ts'

/**
 * A "Read the license" link button that opens the Secret Reports License (fetched from
 * `GET /api/secret-reports/license` on first open) in a scrollable dialog.
 */
export function LicenseButton({ label = 'Read the license' }: { label?: string }) {
  const [open, setOpen] = useState(false)
  const license = useSecretReportsLicense(open)
  return (
    <>
      <button type="button" className="text-accent hover:underline" onClick={() => setOpen(true)}>
        {label}
      </button>
      <Dialog
        isOpen={open}
        onOpenChange={setOpen}
        size="lg"
        title={license.data?.name ?? 'Secret Reports License'}
        description="Its use condition is mandatory for the organization running this Holtkeeper."
        footer={
          <Button variant="primary" onPress={() => setOpen(false)}>
            Close
          </Button>
        }
      >
        {license.isPending ? (
          <Placeholder className="h-64" />
        ) : license.isError ? (
          <ErrorState error={license.error} />
        ) : (
          <pre className="max-h-[60vh] overflow-y-auto rounded-[7px] border border-line bg-raise px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap">
            {license.data.text}
          </pre>
        )}
      </Dialog>
    </>
  )
}
