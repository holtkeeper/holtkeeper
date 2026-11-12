import type {
  ChatCard as Card,
  ChatCardAction,
  ChatCardBlock,
  ChatCardStep,
  ChatCardTone,
  ChatForm,
  ChatStepStatus,
} from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import {
  Check,
  CircleCheck,
  CircleDot,
  CircleDashed,
  CircleX,
  ExternalLink,
  type LucideIcon,
  PauseCircle,
  SkipForward,
} from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useTaskGroupMutations } from '../../api/queries.ts'
import { type FormValues, formCommand, initialValues, missingFields } from '../../lib/chat.ts'
import { taskCancellable, taskStatusLabel, taskStatusTone } from '../../lib/tasks.ts'
import {
  Button,
  ConfirmDialog,
  Markdown,
  MultiToggle,
  Select,
  Switch,
  Tag,
  TextField,
  buttonClass,
  notify,
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
  active: { icon: CircleDot, className: 'text-accent' },
  running: { icon: CircleDot, className: 'animate-pulse text-accent' },
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
              <span aria-hidden className="absolute top-6 bottom-0 left-[9px] w-px bg-line" />
            )}
            <Icon className={`relative mt-0.5 size-[19px] shrink-0 ${className}`} aria-hidden />
            <div className="flex min-w-0 flex-1 items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                <span className="font-medium">{step.label}</span>
                {step.detail ? <span className="text-muted"> — {step.detail}</span> : null}
              </div>
              {step.url ? (
                <a
                  href={step.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex shrink-0 items-center gap-1 text-xs text-accent hover:underline"
                >
                  {step.urlLabel ?? 'Open'} <ExternalLink className="size-3" aria-hidden />
                </a>
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

const flowDot: Record<ChatStepStatus, string> = {
  pending: 'bg-default text-muted',
  waiting: 'bg-default text-muted',
  skipped: 'bg-default text-muted',
  active: 'bg-accent text-accent-foreground ring-4 ring-accent/20',
  running: 'bg-accent text-accent-foreground',
  done: 'bg-success text-success-foreground',
  failed: 'bg-danger text-danger-foreground',
}

/** Short stages in a row: dots joined by lines, the current one ringed. */
function Flow({ items }: { items: readonly ChatCardStep[] }) {
  return (
    <ol className="flex items-start">
      {items.map((step, index) => {
        const reached = step.status === 'done'
        return (
          <li
            key={`${step.label}-${index}`}
            className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
          >
            <div className="flex w-full items-center">
              <span
                aria-hidden
                className={`h-0.5 flex-1 ${index === 0 ? 'invisible' : reached || step.status === 'active' ? 'bg-success' : 'bg-default'}`}
              />
              <span
                className={`grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${flowDot[step.status]}`}
              >
                {step.status === 'done' ? <Check className="size-3" aria-hidden /> : index + 1}
              </span>
              <span
                aria-hidden
                className={`h-0.5 flex-1 ${index === items.length - 1 ? 'invisible' : reached ? 'bg-success' : 'bg-default'}`}
              />
            </div>
            <span
              className={`max-w-full truncate px-1 text-center text-xs ${
                step.status === 'active' ? 'font-semibold text-foreground' : 'text-muted'
              }`}
              title={step.detail ?? step.label}
            >
              {step.label}
            </span>
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
      className="flex flex-col gap-3 rounded-[10px] border border-line bg-raise p-3"
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
    case 'heading':
      return (
        <div className="flex items-baseline justify-between gap-3 pt-1">
          <h4 className="flex items-center gap-2 text-[13px] font-semibold tracking-wide uppercase">
            {block.tone ? (
              <span aria-hidden className={`size-1.5 rounded-full ${toneBar[block.tone]}`} />
            ) : null}
            {block.text}
          </h4>
          {block.detail ? <span className="text-xs text-muted">{block.detail}</span> : null}
        </div>
      )
    case 'divider':
      return <hr className="border-line" />
    case 'steps':
      return block.layout === 'flow' ? <Flow items={block.steps} /> : <Steps items={block.steps} />
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
    case 'task':
      return <TaskBlock block={block} />
    default:
      return null
  }
}

type TaskCardBlock = Extract<ChatCardBlock, { type: 'task' }>

/**
 * A code change: summary, a step per repository as the server updates it (or the repositories
 * with their merge requests on cards without steps), the status, links to its Inbox item while it
 * waits and to the task, and Cancel while something can still stop. Approval happens in the Inbox
 * only.
 */
function TaskBlock({ block }: { block: TaskCardBlock }) {
  const tasks = useTaskGroupMutations()
  const [confirming, setConfirming] = useState(false)
  const groupId = block.groupId
  const waiting = groupId !== undefined && block.status === 'proposed'
  const cancellable = groupId !== undefined && taskCancellable(block.status)
  const merge = new Map((block.mergeRequests ?? []).map((mr) => [mr.repo, mr]))
  const cap = block.budgetUsd !== undefined ? `$${block.budgetUsd.toFixed(2)}` : undefined
  return (
    <div className="flex flex-col gap-2">
      <Markdown text={block.summary} className="text-sm" />
      {block.steps?.length ? (
        <Steps items={block.steps} />
      ) : (
        <ul className="flex flex-col gap-1">
          {block.repos.map((repo) => {
            const mr = merge.get(repo)
            return (
              <li key={repo} className="flex flex-wrap items-center gap-2 text-xs">
                <Tag mono>{repo}</Tag>
                {mr ? (
                  <a
                    href={mr.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mono inline-flex items-center gap-1 hover:underline"
                  >
                    !{mr.id}
                    {mr.draft ? ' draft' : ''}
                    <ExternalLink aria-hidden className="size-3" />
                  </a>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={taskStatusTone[block.status]} dot>
          {taskStatusLabel[block.status]}
        </Tag>
        {waiting && cap ? <span className="mono text-xs text-muted">cap {cap}</span> : null}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {waiting ? (
            <Link
              to="/inbox"
              search={{ item: `task:${groupId}`, kind: 'task' }}
              className={buttonClass('secondary', 'sm', 'no-underline')}
            >
              Review in Inbox
            </Link>
          ) : null}
          {groupId !== undefined ? (
            <Link
              to="/ops/tasks"
              search={{ group: groupId }}
              className={buttonClass('ghost', 'sm', 'no-underline')}
            >
              Task details
            </Link>
          ) : null}
          {cancellable ? (
            <Button
              size="sm"
              variant="ghost"
              isDisabled={tasks.cancel.isPending}
              onPress={() => setConfirming(true)}
            >
              Cancel task
            </Button>
          ) : null}
        </span>
      </div>
      {waiting ? (
        <p className="text-xs text-muted">
          Approvals live in the Inbox, next to everything else waiting on people.
        </p>
      ) : null}
      {cancellable ? (
        <ConfirmDialog
          isOpen={confirming}
          onOpenChange={setConfirming}
          title="Cancel this task?"
          confirmLabel="Cancel it"
          isPending={tasks.cancel.isPending}
          onConfirm={() =>
            tasks.cancel.mutate(groupId, {
              onSuccess: () => {
                setConfirming(false)
                notify.success('Task cancelled')
              },
              onError: (error) => {
                setConfirming(false)
                notify.error('Not cancelled', messageOf(error))
              },
            })
          }
        >
          Queued and running repositories stop. Merge requests already open stay; close them on the
          forge.
        </ConfirmDialog>
      ) : null}
    </div>
  )
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
    <article className="relative max-w-2xl overflow-hidden rounded-[12px] border border-line bg-panel">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${toneBar[tone]}`} />
      <div className="flex flex-col gap-3 py-3.5 pr-4 pl-5">
        {card.title ? (
          <header className="flex items-start justify-between gap-3">
            <h3 className="text-[13px] font-semibold">
              <span
                className={`mr-2 inline-block size-2 rounded-full align-middle ${toneBar[tone]}`}
              />
              {card.title}
              {card.subtitle ? (
                <span className="mt-0.5 block text-xs font-normal text-muted">{card.subtitle}</span>
              ) : null}
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
