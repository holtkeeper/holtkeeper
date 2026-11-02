import type {
  ChatCard as Card,
  ChatCardAction,
  ChatCardBlock,
  ChatCardStep,
  ChatCardTone,
  ChatForm,
  ChatStepStatus,
} from '@holtkeeper/api'
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  LoaderCircle,
  type LucideIcon,
  PauseCircle,
  SkipForward,
} from 'lucide-react'
import { useState } from 'react'

import { type FormValues, formCommand, initialValues, missingFields } from '../../lib/chat.ts'
import {
  Button,
  ConfirmDialog,
  Markdown,
  MultiToggle,
  Select,
  Switch,
  TextField,
  buttonClass,
} from '../../ui/index.ts'

const toneBar: Record<ChatCardTone, string> = {
  neutral: 'bg-default',
  info: 'bg-accent',
  good: 'bg-success',
  warning: 'bg-warning',
  bad: 'bg-danger',
}

const toneText: Record<ChatCardTone, string> = {
  neutral: 'text-muted',
  info: 'text-accent',
  good: 'text-success',
  warning: 'text-warning',
  bad: 'text-danger',
}

const steps: Record<ChatStepStatus, { icon: LucideIcon; className: string }> = {
  pending: { icon: CircleDashed, className: 'text-muted' },
  waiting: { icon: PauseCircle, className: 'text-muted' },
  running: { icon: LoaderCircle, className: 'animate-spin text-accent' },
  done: { icon: CircleCheck, className: 'text-success' },
  failed: { icon: CircleX, className: 'text-danger' },
  skipped: { icon: SkipForward, className: 'text-muted' },
}

function Steps({ items }: { items: readonly ChatCardStep[] }) {
  return (
    <ol className="flex flex-col">
      {items.map((step, index) => {
        const { icon: Icon, className } = steps[step.status]
        const last = index === items.length - 1
        return (
          <li key={`${step.label}-${index}`} className="relative flex gap-3 pb-3 last:pb-0">
            {last ? null : (
              <span aria-hidden className="absolute top-6 bottom-0 left-[9px] w-px bg-default" />
            )}
            <Icon className={`relative mt-0.5 size-[19px] shrink-0 ${className}`} aria-hidden />
            <div className="min-w-0 text-sm">
              {step.url ? (
                <a
                  href={step.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-medium hover:underline"
                >
                  {step.label}
                </a>
              ) : (
                <span className="font-medium">{step.label}</span>
              )}
              {step.detail ? <span className="text-muted"> — {step.detail}</span> : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function Actions({
  actions,
  onRun,
  busy,
}: {
  actions: readonly ChatCardAction[]
  onRun: (command: string) => void
  busy: boolean
}) {
  const [confirming, setConfirming] = useState<ChatCardAction>()
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => (
        <Button
          key={action.command}
          size="sm"
          variant={
            action.style === 'primary'
              ? 'primary'
              : action.style === 'danger'
                ? 'danger-soft'
                : 'secondary'
          }
          isDisabled={busy}
          onPress={() =>
            action.style === 'danger' ? setConfirming(action) : onRun(action.command)
          }
        >
          {action.label}
        </Button>
      ))}
      <ConfirmDialog
        isOpen={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined)
        }}
        title={confirming?.label ?? ''}
        confirmLabel={confirming?.label ?? 'Run'}
        onConfirm={() => {
          if (confirming) onRun(confirming.command)
          setConfirming(undefined)
        }}
      >
        <p className="text-sm text-muted">Runs</p>
        <code className="mt-1 block rounded-lg bg-default px-2 py-1.5 font-mono text-[13px]">
          /holtkeeper {confirming?.command}
        </code>
      </ConfirmDialog>
    </div>
  )
}

function InlineForm({
  form,
  onRun,
  busy,
}: {
  form: ChatForm
  onRun: (command: string) => void
  busy: boolean
}) {
  const [values, setValues] = useState<FormValues>(() => initialValues(form))
  const set = (name: string, value: FormValues[string]) =>
    setValues((current) => ({ ...current, [name]: value }))
  const missing = missingFields(form, values)
  return (
    <form
      className="flex flex-col gap-3 rounded-xl bg-default/40 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (missing.length === 0) onRun(formCommand(form, values))
      }}
    >
      {form.fields.map((field) => {
        if (field.kind === 'toggle')
          return (
            <Switch
              key={field.name}
              label={field.label}
              isSelected={values[field.name] === true}
              onChange={(selected) => set(field.name, selected)}
            />
          )
        if (field.kind === 'select' && field.multiple) {
          const selected = values[field.name]
          return (
            <div key={field.name} className="flex flex-col gap-1">
              <span className="text-sm font-medium">{field.label}</span>
              <MultiToggle
                aria-label={field.label}
                options={field.options.map((option) => ({ id: option.value, label: option.label }))}
                value={Array.isArray(selected) ? selected : []}
                onChange={(next) => set(field.name, next)}
              />
            </div>
          )
        }
        if (field.kind === 'select') {
          const selected = values[field.name]
          return (
            <Select
              key={field.name}
              label={field.label}
              options={field.options.map((option) => ({ id: option.value, label: option.label }))}
              value={typeof selected === 'string' ? selected : undefined}
              onChange={(next) => set(field.name, next)}
            />
          )
        }
        const text = values[field.name]
        return (
          <TextField
            key={field.name}
            label={field.label}
            value={typeof text === 'string' ? text : ''}
            onChange={(next) => set(field.name, next)}
            {...(field.placeholder && { placeholder: field.placeholder })}
            {...(field.multiline && { multiline: true, rows: 3 })}
          />
        )
      })}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" variant="primary" isDisabled={busy || missing.length > 0}>
          {form.submitLabel}
        </Button>
        {missing.length ? (
          <span className="text-xs text-muted">Fill in {missing.join(', ')}</span>
        ) : null}
      </div>
    </form>
  )
}

function Block({
  block,
  onRun,
  busy,
}: {
  block: ChatCardBlock
  onRun: (command: string) => void
  busy: boolean
}) {
  switch (block.type) {
    case 'text':
      return <Markdown text={block.text} className="text-sm" />
    case 'context':
      return <p className="text-xs text-muted">{block.text}</p>
    case 'fields':
      return (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
          {block.fields.map((field) => (
            <div key={field.label} className="min-w-0">
              <dt className="text-xs text-muted">{field.label}</dt>
              <dd className="truncate text-sm font-medium">
                <Markdown text={field.value} />
              </dd>
            </div>
          ))}
        </dl>
      )
    case 'steps':
      return <Steps items={block.steps} />
    case 'list':
      return (
        <ul className="flex flex-col gap-1.5">
          {block.items.map((item, index) => (
            <li key={index} className="flex items-start gap-2 text-sm">
              <span
                aria-hidden
                className={`mt-1.5 size-2 shrink-0 rounded-full ${toneBar[item.tone ?? 'neutral']}`}
              />
              {item.url ? (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="hover:underline"
                >
                  <Markdown text={item.text} />
                </a>
              ) : (
                <Markdown text={item.text} />
              )}
            </li>
          ))}
        </ul>
      )
    case 'actions':
      return <Actions actions={block.actions} onRun={onRun} busy={busy} />
    case 'form':
      return <InlineForm form={block.form} onRun={onRun} busy={busy} />
    default:
      return null
  }
}

/**
 * A Holtkeeper card in the panel: a tone stripe and title, then its blocks. Buttons and forms run
 * their command through `onRun`; danger buttons ask first.
 */
export function ChatCard({
  card,
  onRun,
  busy,
}: {
  card: Card
  onRun: (command: string) => void
  busy: boolean
}) {
  const tone = card.tone ?? 'neutral'
  return (
    <article className="relative overflow-hidden rounded-2xl bg-surface shadow-surface">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${toneBar[tone]}`} />
      <div className="flex flex-col gap-3 py-3.5 pr-4 pl-5">
        {card.title ? (
          <header className="flex items-start justify-between gap-3">
            <h3 className="text-[15px] font-semibold">
              <span
                className={`mr-2 inline-block size-2 rounded-full align-middle ${toneBar[tone]}`}
              />
              {card.title}
            </h3>
            {card.url ? (
              <a
                href={card.url}
                target="_blank"
                rel="noreferrer noopener"
                className={buttonClass('ghost', 'sm', `shrink-0 ${toneText[tone]}`)}
              >
                Open <ExternalLink className="size-3.5" aria-hidden />
              </a>
            ) : null}
          </header>
        ) : null}
        {card.blocks.map((block, index) => (
          <Block key={index} block={block} onRun={onRun} busy={busy} />
        ))}
      </div>
    </article>
  )
}
