import type {
  BotMessageInput,
  BotMessageLocale,
  BotMessageSettings,
  BotMessagesOverview,
} from '@holtkeeper/api'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { request } from './client.ts'
import { keys } from './queries.ts'

const path = (catalog: string, locale: string, key?: string) =>
  `/api/messages/${encodeURIComponent(catalog)}/${encodeURIComponent(locale)}${key ? `/${encodeURIComponent(key)}` : ''}`

/** Endpoints of the bot messages block in Settings › Analyzers. */
const messagesApi = {
  overview: () => request<BotMessagesOverview>('GET', '/api/messages'),
  locale: (catalog: string, locale: string) =>
    request<BotMessageLocale>('GET', path(catalog, locale)),
  saveSettings: (settings: BotMessageSettings) =>
    request<BotMessageSettings>('PUT', '/api/messages/settings', { body: settings }),
  save: (input: { catalog: string; locale: string; key: string } & BotMessageInput) =>
    request<{ ok: true }>('PUT', path(input.catalog, input.locale, input.key), {
      body: { text: input.text },
    }),
  reset: (input: { catalog: string; locale: string; key: string }) =>
    request<{ ok: true }>('DELETE', path(input.catalog, input.locale, input.key)),
  retranslate: (input: { catalog: string; locale: string }) =>
    request<{ dropped: number }>('POST', `${path(input.catalog, input.locale)}/retranslate`),
}

const messagesKey = [...keys.config, 'messages'] as const

/** Bot message catalogs with their translated locales and the translation settings. */
export const useBotMessages = (enabled = true) =>
  useQuery({ queryKey: messagesKey, queryFn: messagesApi.overview, enabled })

/** Every message of one catalog in one locale. */
export const useBotMessageLocale = (catalog: string, locale: string, enabled = true) =>
  useQuery({
    queryKey: [...messagesKey, catalog, locale],
    queryFn: () => messagesApi.locale(catalog, locale),
    enabled,
  })

/** One mutation of bot messages; every one refreshes the whole block. */
function useMessagesMutation<Input, Output>(mutationFn: (input: Input) => Promise<Output>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: () => client.invalidateQueries({ queryKey: messagesKey }),
  })
}

/** Saves whether to translate automatically and the extra terms kept in English. */
export const useSaveBotMessageSettings = () => useMessagesMutation(messagesApi.saveSettings)

/** Saves a person's translation of one message. */
export const useSaveBotMessage = () => useMessagesMutation(messagesApi.save)

/** Drops one translation so the next review translates it again. */
export const useResetBotMessage = () => useMessagesMutation(messagesApi.reset)

/** Drops every automatic translation of a locale; people's translations stay. */
export const useRetranslateBotMessages = () => useMessagesMutation(messagesApi.retranslate)
