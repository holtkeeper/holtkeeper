import { Compass } from 'lucide-react'

import { EmptyState, LinkButton } from '../../ui/index.ts'

export function NotFound() {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <EmptyState
        icon={<Compass />}
        title="Page not found"
        description="The address does not match any page."
        action={
          <LinkButton to="/" variant="secondary">
            Go to dashboard
          </LinkButton>
        }
      />
    </div>
  )
}
