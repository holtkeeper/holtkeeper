# @holtkeeper/testids

The `testids` analyzer and analysis kind: finds interactive elements in a checkout's frontend templates (JSX/TSX, Vue, Svelte, HTML and Angular templates) and records which carry a test id attribute for end-to-end tests. Static: nothing is built or run.

## Public API

- `testIdsAnalyzer` — `Analyzer<TestIdsData, TestIdsOptions>`, kind `testids`, scope `repo`, needs `checkout`. Options (`testIdsOptionsSchema`; lists also accept a comma-separated string, as the flags pass them):
  - `attributes: string[]` (`--attributes`) — attribute or prop names that count as a test id, case-insensitive. Default `defaultAttributes`: `data-testid`, `data-test-id`, `data-test`, `data-qa`, `data-cy`, `testID`, `testId`.
  - `sources: string[]` (`--sources`) — template sources by name from `builtinSources`: `jsx`, `vue`, `svelte`, `html`.
  - `components: Record<string, string>` — component name or `*` pattern → native tag it renders, e.g. `{ "Button": "button", "*Link": "a", "el-button": "button" }`. Checked before anything else; matches the whole name or its last `.` segment.
  - `factories: string[]` — names whose `.tag`, `('tag')` and `(Component)` results are styled tags. Default `defaultFactories`: `styled`, `tw`, `chakra`, `motion`.
  - `aliases: Record<string, string>` — import prefix → folder, on top of `compilerOptions.paths` of the root `tsconfig.json`/`jsconfig.json`, e.g. `{ "@/": "src/" }`.
  - `ignore: string[]` (`--ignore`) — tag or component names (`*` patterns) never reported, e.g. `Trans`.
  - `exclude: string[]` (`--exclude`) — glob patterns of files to skip.
  - `tags`, `events`, `roles`, `markers` — what counts as interactive (see below); defaults `defaultTags`, `defaultEvents`, `defaultRoles`, `defaultMarkers`.
  - `presets` — `testIdPresets`: `testing-library` (`data-testid`), `cypress` (`data-cy`, `data-test`, `data-testid`), `react-native` (`testID`).
- `testIdsAnalysis` — the `AnalysisKind` (`schema: testIdsDataSchema`, `summarize`, `toReport`); `testIdsReport(data, options)` builds the report directly.
- `analyzeTestIds({ dir, sources?, attributes?, components?, factories?, aliases?, ignore?, exclude?, tags?, events?, roles?, markers?, signal? }): Promise<TestIdsData>`.
- Extension points:
  - `TemplateSource` — `{ name, matches(file), scan(text, file) }`; pass your own in `sources` to read another template format. Built in: `jsxSource`, `vueSource`, `svelteSource`, `htmlSource`.
  - `scanTags(text, 'jsx' | 'html')` — the tolerant tag scanner sources build on; `onlyTemplate(text)` and `blankBlocks(text, names)` cut SFC blocks while keeping line numbers.
  - `createResolver(options)` and `parseModule(text, factories)` — component → native tag resolution.
  - `createClassifier(rules)`, `eventOf(name)`, `bareName(name)` — what is interactive and tagged.
- Helpers: `testIdTotals(files)`, `taggedPercent(counts)`, `tsconfigAliases(dir)`.

## How elements are found

1. **Files** — every file `listFiles` lists (dependency, build and hidden folders skipped) that a source matches, except tests, stories, mocks, fixtures and `exclude` matches. `jsx` reads `.jsx`, `.tsx` and `.js`/`.mjs` files that contain JSX; `vue` the outer `<template>`; `svelte` and `html` the markup outside `<script>` and `<style>`.
2. **Tags** — a scanner, not a parser: in JSX `<` opens a tag only where an expression can start (not after an identifier, `)` or `]`, except after `return`, `yield` and similar), so comparisons and type arguments are skipped; tags inside `{…}` attribute expressions are found too, as are lit `html\`…\`` templates. Attributes keep their written names (`onClick`, `:data-testid`, `@click.prevent`, `v-on:click`, `on:click`, `(click)`, `[attr.data-cy]`); `{...props}`and`v-bind="…"` mark a spread.
3. **Native tag** — lower-case names are native. Other names go through `components`, then `<factory>.tag` members (`<motion.button>`), then styled definitions: `const X = styled.button`, `styled('a')`, `styled(Other)` (linaria, styled-components, emotion, MUI, chakra, tailwind-styled-components), followed across named, default and namespace imports (`<S.Submit>`), `export { … } from`, `export * from` barrels, relative paths and aliases. Components it cannot see through (a design system's `Button`, a Vue SFC) stay unresolved.
4. **Interactive** — a native tag in `tags` (`a`, `button`, `input` except `type="hidden"`, `select`, `textarea`, `summary`); any element or component with a handler for one of `events` (`click`, `press`, `change`, `input`, `submit`, …, in any binding syntax), a widget `role`, `contenteditable` or a non-negative `tabindex`; and an unresolved component (or `a`) with one of `markers` (`href`, `to`, `routerLink`, `v-model`, `bind:value`, …). `onClose` on a `Modal` does not count; map such components in `components` when they render a control.
5. **Verdict** — `tagged` when any attribute's bare name (binding syntax stripped) is in `attributes`; otherwise `unverified` when the element spreads props (its caller may pass a test id) and `missing` when not.

## Data

```ts
interface TestIdsData {
  attributes: string[] // what counted as a test id
  usage: Record<string, number> // tagged elements per attribute
  files: {
    file: string
    source: string // jsx, vue, svelte, html
    total: number // interactive elements
    tagged: number
    unverified: number
    elements: {
      // untagged elements, missing first, at most 200 per file
      line: number
      tag: string // as written: S.Submit
      as?: string // native tag when resolved and different: button
      reason: string // button, click handler, role=tab, href, ...
      status: 'missing' | 'unverified'
    }[]
  }[]
}
```

Only files with at least one interactive element are kept.

## Report

- **Metrics** — share with a test id (`percent`, `better: 'up'`, good from 90%, bad below 50%), interactive elements, missing test ids and unverified (`better: 'down'`).
- **By folder** — treemap down to three levels, sized by interactive elements and colored by the share with a test id; a donut of attributes in use when the project mixes several.
- **Files with untagged elements** — the 50 files with the most missing test ids.
- **Elements without a test id** — up to 300 issues, `file:line <Tag> → tag` with the reason.
- **Changes** (with a previous analysis) — files whose number of missing test ids changed.

It runs in the default `tests-weekly` schedule (Wednesday nights). The web panel shows it under **Test ids** (`/testids`).

## Limitations

- The scanner is heuristic: a JSX tag right after an identifier other than the listed keywords is missed, and `<` comparisons written without spaces after `return` read as tags (non-interactive ones are ignored).
- Wrapper components written by hand (`const Button = (props) => <button {...props} />`) are not resolved; their own `<button {...props}>` is reported as `unverified`, and their callers count only by handlers and markers. Map them in `components`.
- Styled definitions are recognized only as `const`/`let`/`var` declarations or `export default`; object members (`S = { Button: styled.button }`) are not.
- Bare package imports (`@company/ui`) are not followed; map their components in `components`.
