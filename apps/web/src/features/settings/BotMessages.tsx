import type {
  BotMessageCatalogSummary,
  BotMessageRow,
  BotMessageSettings,
  BotMessageState,
} from '@holtkeeper/api'
import { Languages, RefreshCw } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useBotMessageLocale,
  useBotMessages,
  useResetBotMessage,
  useRetranslateBotMessages,
  useSaveBotMessage,
  useSaveBotMessageSettings,
} from '../../api/settings-messages.ts'
import { formatRelative } from '../../lib/format.ts'
import type { StatusTone } from '../../ui/colors.ts'
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Notice,
  Placeholder,
  Switch,
  Table,
  Tag,
  TagInput,
  Td,
  TextField,
  Th,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { SystemPanel } from '../storage/SystemPanel.tsx'

const stateLabel: Record<BotMessageState, string> = {
  translated: 'Translated',
  manual: 'Edited',
  outdated: 'Outdated',
  missing: 'Missing',
}

const stateTone: Record<BotMessageState, StatusTone> = {
  translated: 'success',
  manual: 'accent',
  outdated: 'warning',
  missing: 'default',
}

const states: readonly BotMessageState[] = ['translated', 'manual', 'outdated', 'missing']

const LOCALE_CODE = /^[a-z]{2,3}$/

/** Whether automatic translation is on and the extra terms kept in English. */
function TranslationSettings({
  settings,
  builtInTerms,
  canWrite,
}: {
  settings: BotMessageSettings
  builtInTerms: readonly string[]
  canWrite: boolean
}) {
  const save = useSaveBotMessageSettings()
  const update = (next: BotMessageSettings) =>
    save.mutate(next, {
      onSuccess: () => notify.success('Saved'),
      onError: (error) => notify.error('Not saved', messageOf(error)),
    })
  return (
    <div className="flex flex-col gap-3">
      <Switch
        label="Translate automatically"
        description="Missing and outdated texts are translated by the AI model (fast tier) the first time a review in that language needs them. When the English text changes, its translations are outdated and made again. Off: such texts are posted in English."
        isSelected={settings.autoTranslate}
        isDisabled={!canWrite || save.isPending}
        onChange={(autoTranslate) => update({ ...settings, autoTranslate })}
      />
      <TagInput
        label="Also keep in English"
        description={
          <>
            Always kept: {builtInTerms.join(', ')}. Adding a term outdates the translations that use
            it.
          </>
        }
        values={settings.terms}
        isDisabled={!canWrite || save.isPending}
        placeholder="Add a term"
        onChange={(terms) => update({ ...settings, terms })}
      />
    </div>
  )
}

/** One message in the locale editor: the English text, its translation and the actions on it. */
function MessageEditor({
  catalog,
  locale,
  row,
  canWrite,
}: {
  catalog: string
  locale: string
  row: BotMessageRow
  canWrite: boolean
}) {
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const save = useSaveBotMessage()
  const reset = useResetBotMessage()
  return (
    <tr>
      <Td valign="top" className="w-[38%]">
        <div className="flex flex-col gap-1">
          <code className="mono text-xs text-muted">{row.key}</code>
          <span className="whitespace-pre-wrap">{row.source}</span>
          {row.note ? <span className="text-xs text-muted">{row.note}</span> : null}
        </div>
      </Td>
      <Td valign="top">
        <Tag tone={stateTone[row.state]} dot>
          {stateLabel[row.state]}
        </Tag>
      </Td>
      <Td valign="top">
        {draft === undefined ? (
          <div className="flex flex-col gap-1">
            <span
              className={`whitespace-pre-wrap ${row.state === 'outdated' ? 'text-muted line-through' : ''}`}
            >
              {row.text ?? <span className="text-muted">Posted in English</span>}
            </span>
            {row.previous ? (
              <span className="text-xs text-muted">Replaces a person's text: {row.previous}</span>
            ) : null}
            {row.updatedAt ? (
              <span className="text-xs text-muted">
                {row.by ? `${row.by}, ` : ''}
                {formatRelative(row.updatedAt)}
              </span>
            ) : null}
          </div>
        ) : (
          <TextField
            aria-label={`Translation of ${row.key}`}
            value={draft}
            onChange={setDraft}
            multiline
            rows={3}
            autoFocus
          />
        )}
      </Td>
      <Td valign="top" align="right">
        {!canWrite ? null : draft === undefined ? (
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onPress={() => setDraft(row.text ?? row.source)}>
              Edit
            </Button>
            {row.text ? (
              <Button
                size="sm"
                variant="ghost"
                isPending={reset.isPending}
                onPress={() =>
                  reset.mutate(
                    { catalog, locale, key: row.key },
                    { onError: (error) => notify.error('Not reset', messageOf(error)) },
                  )
                }
              >
                Reset
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onPress={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              isPending={save.isPending}
              isDisabled={!draft.trim()}
              onPress={() =>
                save.mutate(
                  { catalog, locale, key: row.key, text: draft },
                  {
                    onSuccess: () => setDraft(undefined),
                    onError: (error) => notify.error('Not saved', messageOf(error)),
                  },
                )
              }
            >
              Save
            </Button>
          </div>
        )}
      </Td>
    </tr>
  )
}

/** Every message of a catalog in one locale, editable by people with `settings:write`. */
function LocaleDialog({
  catalog,
  locale,
  canWrite,
  onClose,
}: {
  catalog: string
  locale: string
  canWrite: boolean
  onClose: () => void
}) {
  const view = useBotMessageLocale(catalog, locale)
  const retranslate = useRetranslateBotMessages()
  const [confirm, setConfirm] = useState(false)
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      size="xl"
      title={view.data ? `${view.data.title} · ${view.data.label}` : 'Messages'}
      description={
        view.data
          ? `Placeholders in braces, code spans and links must stay as they are. The model keeps ${view.data.terms.join(', ')} in English. Reset drops a translation; the next review in this language translates it again.`
          : undefined
      }
      footer={
        canWrite ? (
          <Button variant="secondary" onPress={() => setConfirm(true)}>
            <RefreshCw className="size-3.5" />
            Translate again
          </Button>
        ) : undefined
      }
    >
      {view.isPending ? (
        <Placeholder className="h-96" />
      ) : view.isError ? (
        <ErrorState error={view.error} />
      ) : (
        <Table label="Messages">
          <thead>
            <tr>
              <Th>English</Th>
              <Th>State</Th>
              <Th>Translation</Th>
              <Th align="right">{canWrite ? 'Actions' : ''}</Th>
            </tr>
          </thead>
          <tbody>
            {view.data.rows.map((row) => (
              <MessageEditor
                key={row.key}
                catalog={catalog}
                locale={locale}
                row={row}
                canWrite={canWrite}
              />
            ))}
          </tbody>
        </Table>
      )}
      <ConfirmDialog
        isOpen={confirm}
        onOpenChange={setConfirm}
        title="Translate this language again?"
        confirmLabel="Drop automatic translations"
        isPending={retranslate.isPending}
        onConfirm={() =>
          retranslate.mutate(
            { catalog, locale },
            {
              onSuccess: (result) => {
                setConfirm(false)
                notify.success(
                  `Dropped ${result.dropped} translation(s)`,
                  'The next review in this language translates them again.',
                )
              },
              onError: (error) => notify.error('Not dropped', messageOf(error)),
            },
          )
        }
      >
        Automatic translations are dropped and made again by the next review in this language.
        Translations people edited stay.
      </ConfirmDialog>
    </Dialog>
  )
}

/** The locales of one catalog with how many of its messages are translated in each. */
function CatalogLocales({
  catalog,
  canWrite,
  onOpen,
}: {
  catalog: BotMessageCatalogSummary
  canWrite: boolean
  onOpen: (locale: string) => void
}) {
  const [code, setCode] = useState('')
  const valid = LOCALE_CODE.test(code) && code !== 'en'
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h3 className="text-[13px] font-semibold">
          {catalog.title}{' '}
          <span className="font-normal text-muted">· {catalog.messages} messages</span>
        </h3>
        {canWrite ? (
          <div className="flex items-end gap-2">
            <TextField
              aria-label="Language code"
              placeholder="Language code, e.g. de"
              value={code}
              onChange={(value) => setCode(value.trim().toLowerCase())}
              className="w-48"
            />
            <Button size="sm" isDisabled={!valid} onPress={() => onOpen(code)}>
              Edit language
            </Button>
          </div>
        ) : null}
      </div>
      {catalog.locales.length ? (
        <Table label={`${catalog.title} translations`}>
          <thead>
            <tr>
              <Th>Language</Th>
              {states.map((state) => (
                <Th key={state} align="right">
                  {stateLabel[state]}
                </Th>
              ))}
              <Th>Last failure</Th>
              <Th align="right" />
            </tr>
          </thead>
          <tbody>
            {catalog.locales.map((locale) => (
              <tr key={locale.locale}>
                <Td>
                  {locale.label} <code className="mono text-xs text-muted">{locale.locale}</code>
                </Td>
                {states.map((state) => (
                  <Td key={state} align="right">
                    {locale.counts[state] ? (
                      <Tag tone={stateTone[state]}>{locale.counts[state]}</Tag>
                    ) : (
                      <span className="text-muted">0</span>
                    )}
                  </Td>
                ))}
                <Td>
                  {locale.failedAt ? (
                    <span className="text-xs text-danger" title={locale.failure}>
                      {formatRelative(locale.failedAt)}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Td>
                <Td align="right">
                  <Button size="sm" variant="ghost" onPress={() => onOpen(locale.locale)}>
                    {canWrite ? 'Edit' : 'View'}
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="text-xs text-muted">
          No translations yet: they appear after the first review of a merge request written in
          another language.
        </p>
      )}
    </div>
  )
}

const panel = (children: ReactNode) => (
  <SystemPanel
    id="messages"
    title="Bot messages"
    description="Fixed texts Holtkeeper posts on merge requests, in the language of each merge request"
  >
    <div className="flex flex-col gap-4 p-3.5">{children}</div>
  </SystemPanel>
)

/**
 * Bot messages for Settings › Analyzers: the fixed texts Holtkeeper posts on merge requests
 * (review summary, progress note, thread replies), the languages they are translated into, the
 * translation settings and an editor per language. Global `settings:read`; editing needs a global
 * `settings:write`.
 */
export function BotMessages() {
  const { canGlobal } = useSession()
  const readable = canGlobal('settings:read')
  const canWrite = canGlobal('settings:write')
  const overview = useBotMessages(readable)
  const [open, setOpen] = useState<{ catalog: string; locale: string } | undefined>(undefined)
  if (!readable) return null
  if (overview.isPending) return panel(<Placeholder className="h-40" />)
  if (overview.isError) return panel(<ErrorState error={overview.error} />)
  const data = overview.data
  if (!data.available)
    return panel(
      <EmptyState
        icon={<Languages />}
        title="Translations need a key-value store"
        description="Run the server with a store that has one; until then every text is posted in English."
      />,
    )
  return panel(
    <>
      <Notice title="How the language is chosen">
        The review's <code>language</code> option wins; otherwise the language of the merge request
        description, as the review agent writes in it. Severity labels, categories, code and the
        terms below stay in English.
      </Notice>
      <TranslationSettings
        settings={data.settings}
        builtInTerms={data.builtInTerms}
        canWrite={canWrite}
      />
      {data.catalogs.map((catalog) => (
        <CatalogLocales
          key={catalog.id}
          catalog={catalog}
          canWrite={canWrite}
          onOpen={(locale) => setOpen({ catalog: catalog.id, locale })}
        />
      ))}
      {open ? (
        <LocaleDialog
          catalog={open.catalog}
          locale={open.locale}
          canWrite={canWrite}
          onClose={() => setOpen(undefined)}
        />
      ) : null}
    </>,
  )
}
