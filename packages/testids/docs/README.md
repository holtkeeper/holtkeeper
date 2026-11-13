# @holtkeeper/testids

The `testids` analyzer and analysis kind: lists the test attributes (`data-test-id`, `data-test-state`, `data-qa`, ...) a checkout's frontend templates (JSX/TSX, Vue, Svelte, HTML and Angular templates) expose, per component, so end-to-end tests can be written against them. Static: nothing is built or run.

Recommending test ids on new code is the job of the `testids` check (`testIdsCheck`), which the merge request review runs by default and hands to its agent, and of the MCP tools `test_ids` and `suggest_test_ids`. The analysis itself only catalogs what exists; the conventions those use are learned from the catalog (`learnTestIdOptions`), with the team's overrides from the `analyzers.testids` setting on top. People see them in the Guide's **Test ids** section, where the setting is edited too; there is no page of its own.

## Public API

- `testIdsAnalyzer` — `Analyzer<TestIdsData, TestIdsOptions>`, kind `testids`, scope `repo`, needs `checkout`; it has no `appliesTo`: test ids may sit in any folder or in server-rendered `.html` templates (a Go service with its UI in `web/`), so every repository is analyzed. Options (`testIdsOptionsSchema`; lists also accept a comma-separated string, as the flags pass them):
  - `attributes: string[]` (`--attributes`) — test attribute names, case-insensitive; each also covers names extending it with `-`, so `data-test` covers `data-test-id` and `data-test-state`. Default `defaultAttributes`: `data-testid`, `data-test`, `data-qa`, `data-cy`, `testID`, `testId`. Set in the `analyzers.testids` setting, it also picks the attribute new ids use: the listed name the repository uses most (literal values first), or the first item when the repository uses none of them; order does not matter otherwise.
  - `sources: string[]` (`--sources`) — template sources by name from `builtinSources`: `jsx`, `vue`, `svelte`, `html`.
  - `exclude: string[]` (`--exclude`) — glob patterns of files to skip.
  - `elements?: string[]` — native tags that need a test id, for the check and `suggest_test_ids`; unset, learned from the catalog. The catalog ignores it.
  - `presets` — `testIdPresets`: `testing-library` (`data-testid`), `cypress` (`data-cy`, `data-test`, `data-testid`), `react-native` (`testID`).
- `testIdsAnalysis` — the `AnalysisKind` (`schema: testIdsDataSchema`, `summarize`, `toReport`); the report holds the headline numbers and the learned convention only.
- `analyzeTestIds({ dir, sources?, attributes?, exclude?, signal? }): Promise<TestIdsData>` — the catalog.
- `testIdsCheck(options?)` — a `QualityCheck` named `testids` (`TESTIDS_TOOL`): interactive elements without a test attribute as `missing-test-id` issues (category `tests`, severity `warning`). It skips itself when the project uses no test attributes at all. Otherwise it learns the convention from the checkout's catalog, applies `options.overrides` (`TestIdOverrides`) and runs `findUntagged` with the learned attributes, element kinds and naming. Each issue's `help` names the id attribute the component (or else the project) uses most, never a name merely extending it, with example values, and an id suggested in the project's style (`suggested: \`data-qa="cart-row-remove-button"\``). Other options are those of `findUntagged`without`dir`and`naming`.
- Learned conventions (`learn.ts`):
  - `learnTestIdOptions(data): LearnedTestIdOptions | undefined` — from a catalog: `attribute` (`idAttribute`: the most used configured or well-known id name — `data-testid`, `data-test-id`, `data-test`, `data-qa`, `data-cy`, `testID`/`testId` — preferring one with literal values; a name merely extending one, like `data-test-state`, wins only when no id name is in use), `attributes` (every name in use), `elements` (native tags of `defaultTags` that carry ids; only from 20 tagged elements on, before that the defaults apply), `naming` (`TestIdNaming`: `separator` `-`/`_`/`.`/`''`, `case` `lower`/`camel`/`pascal`, `prefix` `none`, `component` in the same style or `name` as written, each by majority vote), `examples` and `tagged`. Deterministic, no LLM.
  - `testIdOverridesSchema` / `testIdOverridesOf(value)` — the team's `attributes` (new ids use the one the repository uses most, else the first), `elements` and `exclude` from a raw `analyzers.testids` value; anything invalid reads as no override.
  - `testIdConvention(learned, overrides?)` — the rules that apply, overrides winning field by field, with `overridden` listing what the team set; `undefined` without any attribute. `renderTestIdConvention(convention)` writes it as Markdown bullets.
  - `suggestTestId(element, component, naming)` — an id from the component name (per `prefix`), what the element is for (its `name`, `aria-label`, `placeholder`, `title`, `alt`, `label` or `id`, else the function its handler calls without `handle`/`on`, else a component tag's own name) and its kind (`link` for `a`): `cart-row-remove-button`. The same input always gives the same id.
- `findUntagged({ dir, sources?, attributes?, exclude?, components?, factories?, aliases?, ignore?, tags?, events?, roles?, markers?, naming?, signal? }): Promise<UntaggedElement[]>` — interactive elements without a test attribute (see below); with `naming` each one carries a `suggestion`.
- `findUntaggedInText({ file, text, ...rules })` — the same for one file's text (unsaved content): styled components defined in the file are followed, imports are not; empty when no source reads the file.
  - `components: Record<string, string>` — component name or `*` pattern → native tag it renders, e.g. `{ "Button": "button", "*Link": "a", "el-button": "button" }`. Checked before anything else; matches the whole name or its last `.` segment.
  - `factories: string[]` — names whose `.tag`, `('tag')` and `(Component)` results are styled tags. Default `defaultFactories`: `styled`, `tw`, `chakra`, `motion`.
  - `aliases: Record<string, string>` — import prefix → folder, on top of `compilerOptions.paths` of the root `tsconfig.json`/`jsconfig.json`, e.g. `{ "@/": "src/" }`.
  - `ignore: string[]` — tag or component names (`*` patterns) never reported, e.g. `Trans`.
  - `tags`, `events`, `roles`, `markers` — what counts as interactive; defaults `defaultTags`, `defaultEvents`, `defaultRoles`, `defaultMarkers`.
- Extension points:
  - `TemplateSource` — `{ name, matches(file), scan(text, file) }`; pass your own in `sources` to read another template format. Built in: `jsxSource`, `vueSource`, `svelteSource`, `htmlSource`.
  - `scanTags(text, 'jsx' | 'html')` — the tolerant tag scanner sources build on; attributes keep their literal `value` or their `expression` as written. `onlyTemplate(text)` and `blankBlocks(text, names)` cut SFC blocks while keeping line numbers.
  - `createResolver(options)` and `parseModule(text, factories)` — component → native tag resolution.
  - `createClassifier(rules)`, `createAttributeMatcher(attributes)`, `eventOf(name)`, `bareName(name)` — what is interactive and what is a test attribute.
- Helpers: `attributeUsage(components)`, `componentName(file)`, `tsconfigAliases(dir)`.

## How the catalog is built

1. **Files** — every file `listFiles` lists (dependency, build and hidden folders skipped) that a source matches, except tests, stories, mocks, fixtures and `exclude` matches. `jsx` reads `.jsx`, `.tsx` and `.js`/`.mjs` files that contain JSX; `vue` the outer `<template>`; `svelte` and `html` the markup outside `<script>` and `<style>`.
2. **Tags** — a scanner, not a parser: in JSX `<` opens a tag only where an expression can start (not after an identifier, `)` or `]`, except after `return`, `yield` and similar), so comparisons and type arguments are skipped; tags inside `{…}` attribute expressions are found too, as are lit `html\`…\`` templates. Attributes keep their written names (`:data-test-state`, `[attr.data-cy]`).
3. **Component** — one per template file, named after the file (`LoginForm.tsx` → `LoginForm`, `user.component.html` → `user`); `index.*` and SvelteKit `+page.*` files take their folder's name.
4. **Attributes** — every element with at least one test attribute, with each test attribute's bare name and value: quoted values and string literals (`{"save"}`, `:data-test="'save'"`, `` `save` ``) are static; bindings and templates with placeholders are `dynamic` and keep the expression as written (`status`, `` `row-${id}` ``).

## How untagged elements are found

Used by `findUntagged` and the check, not by the catalog.

1. **Native tag** — lower-case names are native. Other names go through `components`, then `<factory>.tag` members (`<motion.button>`), then styled definitions: `const X = styled.button`, `styled('a')`, `styled(Other)` (linaria, styled-components, emotion, MUI, chakra, tailwind-styled-components), followed across named, default and namespace imports (`<S.Submit>`), `export { … } from`, `export * from` barrels, relative paths and aliases. Components it cannot see through (a design system's `Button`, a Vue SFC) stay unresolved.
2. **Interactive** — a native tag in `tags` (`a`, `button`, `input` except `type="hidden"`, `select`, `textarea`, `summary`); any element or component with a handler for one of `events` (`click`, `press`, `change`, `input`, `submit`, …, in any binding syntax), a widget `role`, `contenteditable` or a non-negative `tabindex`; and an unresolved component (or `a`) with one of `markers` (`href`, `to`, `routerLink`, `v-model`, `bind:value`, …). `onClose` on a `Modal` does not count; map such components in `components` when they render a control.
3. **Verdict** — tagged when any attribute matches `attributes`; otherwise `unverified` when the element spreads props (its caller may pass a test id) and `missing` when not. The check reports only `missing`.

## Data

```ts
interface TestIdsData {
  attributes: string[] // configured names; each also covers `<name>-…`
  components: {
    name: string // LoginForm
    file: string
    source: string // jsx, vue, svelte, html
    total: number // elements with test attributes
    elements: {
      // in line order, at most 500 per file
      line: number
      tag: string // as written: S.Submit
      attributes: { name: string; value: string; dynamic?: boolean }[]
    }[]
  }[]
}
```

Only files with at least one test attribute are kept. Analyses stored before the catalog read as empty.

## Report

- **Metrics** — components with test attributes, elements with test attributes, attribute names in use.
- **Convention** — the learned convention (`renderTestIdConvention`).

It runs in the default `tests-weekly` schedule (Wednesday nights). Records stored before the catalog read as empty.

## Limitations

- The scanner is heuristic: a JSX tag right after an identifier other than the listed keywords is missed, and `<` comparisons written without spaces after `return` read as tags.
- A component is a file: files that define several components list them together, and attributes passed down to a wrapper show up where they are written, not where they end up in the DOM.
- Wrapper components written by hand (`const Button = (props) => <button {...props} />`) are not resolved when looking for untagged elements; their own `<button {...props}>` is `unverified`, and their callers count only by handlers and markers. Map them in `components`.
- Styled definitions are recognized only as `const`/`let`/`var` declarations or `export default`; object members (`S = { Button: styled.button }`) are not. Bare package imports (`@company/ui`) are not followed.
