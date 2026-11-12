import { Link2 } from 'lucide-react'

import { type MoreMenuItem, notify } from '../../ui/index.ts'

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(window.location.href)
    notify.success('Link copied')
  } catch {
    notify.error('Not copied', 'The browser did not allow the clipboard.')
  }
}

/** The ⋯ menu entry that copies the current page's URL. */
export const copyLinkItem: MoreMenuItem = {
  label: 'Copy link',
  icon: Link2,
  onAction: () => void copyLink(),
}
