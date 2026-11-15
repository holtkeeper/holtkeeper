# @holtkeeper/messages

Translations of the fixed texts Holtkeeper posts (a review's progress note, summary lines, thread replies). English is the source and lives in code; translations live in the key-value store, are made by the AI model when a language is first needed, can be edited in the panel, and go stale on their own when the English text changes.

## Catalogs

`defineCatalog({ id, title, messages, terms? })` declares the English texts of one feature. Each message is `{ text, note? }`: `text` may hold `{name}` placeholders that `formatMessage(text, params)` fills; `note` tells translators (people and the model) where the text appears. `terms` lists words of this catalog that must stay in English, on top of `DEFAULT_TERMS` (`Holtkeeper`, `merge request`, `MR`, `Severity`, `Critical`, `Major`, `Minor`, `Info`, `Package`, `Kind`) and the terms an admin adds (`MessageSettings.terms`). `termsOf(catalog, settings)` gives the full list.

Texts that must never change (headings and markers other runs search for, severity labels) do not belong in a catalog.

## Staleness

Every stored translation keeps the `sourceHash` of the English text it was made from: `sourceHash(text, terms)` covers the text and the terms that text uses (whole words, case-insensitive). A translation is current only while the hash matches, so editing the English text, or adding or removing a term the text contains, makes it **outdated**; until it is translated again the English text is posted. Adding a term outdates only the messages that contain it.

States per message (`messageRows(catalog, stored, terms)`): `translated` (current, by the model), `manual` (current, by a person), `outdated`, `missing`.

## Resolving

`resolveMessages({ catalog, locale, store?, translator?, now?, log? })` returns `Messages` (`locale`, `t(key, params?)`). It never throws; anything it cannot use falls back to English.

- `en`, an empty locale or no store: English.
- Messages without a current translation are sent to the `translator` in one call when `autoTranslate` is on (the default) and the last failure for that language is older than `RETRY_AFTER_MS` (1 hour). An outdated translation by a person goes along as the `previous` wording to keep.
- Every answer is checked by `translationProblem(source, translation, terms)`: not empty or far longer than the source; the same `{placeholders}` and code spans; no added HTML comments, @mentions or links; every term of the source kept in English. Rejected answers are logged and the message stays English.
- Accepted answers are stored with `origin: 'auto'`, unless a person edited that message while the call ran (their edit wins). A failed call records `failedAt` and `failure`.

`agentTranslator({ agent, dir?, track? })` is the `Translator` over an `Agent`: one structured task on the `fast` tier, one turn, no tools (`capabilities: []`), `taskKind: 'translate'` (`TRANSLATE_TASK_KIND`), at most $0.10. `track(result)` receives every agent result, e.g. to add its usage to the run.

## Locales

`normalizeLocale(language)` turns a BCP 47 code (`pt-BR` → `pt`) or a language name in English or in the language itself (`Russian`, `русский`) into a language code, or `undefined`. `localeLabel(code)` is its English name. `detectLocale(text)` guesses the language of free text (a merge request description): by script, then by common words for Latin-script languages; `undefined` when there is too little text. `SOURCE_LOCALE` is `en`.

## Store

`MessageStore`: `settings()` / `saveSettings()` (`{ autoTranslate, terms }`, `messageSettingsSchema`, defaults `DEFAULT_MESSAGE_SETTINGS`), `locales(catalog)`, `read(catalog, locale)` and `update(catalog, locale, change)`, which applies a change to the stored `LocaleTranslations` atomically.

`kvMessageStore(kv)` keeps everything in a `MessageKv` (the store's `kv`): `messages:settings`, `messages:<catalog>:locale:<locale>` and the index `messages:<catalog>:locales`. Updates use `compareAndSet` when the store has it (5 attempts, then a plain write). `memoryMessageStore()` is for tests.

## Users

- `@holtkeeper/review` — `reviewMessageCatalog` with the progress note, summary lines and thread notes.
- `@holtkeeper/server` — wires `kvMessageStore` into the review analyzer and serves `/api/messages` for the panel's Settings › Analyzers › Bot messages.
