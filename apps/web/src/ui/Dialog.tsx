import { Modal } from '@heroui/react'
import type { ReactNode } from 'react'

import { Button } from './Button.tsx'

export interface DialogProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  /** Buttons at the bottom; omit for content-only dialogs. */
  footer?: ReactNode
  /** `xl` is a wide workspace for editors with a side column. */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  isDismissable?: boolean
}

/** A modal dialog; Escape and the close button dismiss it, focus is trapped while open. */
export function Dialog({
  isOpen,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  isDismissable = true,
}: DialogProps) {
  return (
    <Modal.Backdrop
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={isDismissable}
      variant="blur"
    >
      <Modal.Container size={size === 'xl' ? 'lg' : size} placement="center" scroll="inside">
        <Modal.Dialog {...(size === 'xl' ? { className: 'w-full max-w-6xl!' } : {})}>
          <Modal.CloseTrigger />
          <Modal.Header className="flex flex-col items-start gap-1">
            <Modal.Heading>{title}</Modal.Heading>
            {description ? <p className="text-sm text-muted">{description}</p> : null}
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-4">{children}</Modal.Body>
          {footer ? <Modal.Footer>{footer}</Modal.Footer> : null}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}

/** Asks before a destructive action. */
export function ConfirmDialog({
  isOpen,
  onOpenChange,
  title,
  children,
  confirmLabel = 'Delete',
  onConfirm,
  isPending,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  children?: ReactNode
  confirmLabel?: string
  onConfirm: () => void
  isPending?: boolean
}) {
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="tertiary" onPress={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="danger" onPress={onConfirm} isPending={isPending === true} autoFocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children ? <div className="text-sm text-muted">{children}</div> : null}
    </Dialog>
  )
}
