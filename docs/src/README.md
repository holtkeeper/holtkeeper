# Website

The public site and documentation at https://holtkeeper.github.io: an Astro project with Starlight for the docs and a custom landing page, both in the panel's Graphite look.

```sh
bun run docs:dev     # from the repository root
bun run docs:build   # writes docs/dist
```

## Sections

The header has one tab per reader; each is a `starlight-sidebar-topics` topic in `astro.config.ts`.

| Section   | Route         | For                            | Where its pages live                                                   |
| --------- | ------------- | ------------------------------ | ---------------------------------------------------------------------- |
| Start     | `/start/`     | everyone, first hour           | `src/content/docs/start/`                                              |
| Guide     | `/guide/`     | people using the panel         | `src/content/docs/guide/<workspace>/`, one page per screen             |
| Agents    | `/agents/`    | coding agents and their owners | `src/content/docs/agents/` plus `docs/libraries.md`                    |
| Self-host | `/self-host/` | operators                      | `src/content/docs/self-host/` plus `docs/deployment.md`                |
| Develop   | `/develop/`   | contributors                   | `src/content/docs/develop/`, project docs from `docs/`, module READMEs |
| Reference | `/reference/` | look-up                        | `src/content/docs/reference/`                                          |

The Guide's sidebar groups follow the panel's rail (Home, Repos, Chat, Supply chain, Quality, Releases, Knowledge, Ops) plus Settings and Account; each group autogenerates from its folder and orders pages by `sidebar.order`. Group icons are the rail's (`src/components/rail-icons.ts`).

## Where repository markdown goes

The site also renders markdown where it lives in the repository; nothing is copied.

| Source                                                                                | Route                              |
| ------------------------------------------------------------------------------------- | ---------------------------------- |
| `docs/development.md`, `docs/PLAN.md`, `docs/agent-access.md`, `docs/library-docs.md` | `/develop/<name>/`                 |
| `docs/deployment.md`                                                                  | `/self-host/reference/deployment/` |
| `docs/libraries.md`                                                                   | `/agents/library-docs/`            |
| `docs/README.md`                                                                      | `/modules/`                        |
| `apps/<dir>/docs/README.md`, `packages/<dir>/docs/README.md`                          | `/modules/<dir>/`                  |

- `src/docs/sources.ts` discovers the files and assigns routes. A new module needs no change here: its README is picked up and grouped by `src/docs/groups.ts` (by name, then by prefix; unknown modules land in "Other").
- `src/docs/loader.ts` is the `docs` collection loader. These files have no frontmatter: the first `# H1` becomes the title, the first paragraph the description, and "Edit page" points at the file on GitHub.
- `src/docs/links.ts` rewrites relative links while the markdown is rendered: links between rendered files become site routes, links to anything else become GitHub URLs on `main`.

## Writing a page

Guide pages are `.mdx`. Start from `src/content/docs/guide/quality/bundles.mdx`. Frontmatter beyond Starlight's:

| Key          | Example             | Shows                                 |
| ------------ | ------------------- | ------------------------------------- |
| `panel`      | `Quality › Bundles` | "In the panel: …" tag under the title |
| `route`      | `/quality/bundles`  | the panel route as a mono tag         |
| `permission` | `analyses:read`     | "Needs …" tag                         |

Write for the person in front of the screen: what they see, what each control does, how to get a task done. Component names, routes of the API and helper functions belong in the module's own docs, not here. Use made-up names only (`acme/checkout-web`, `@acme/widget-kit`, `ABC-123`).

### Interface examples

Every guide page shows the screen it documents. `import { … } from '@ui'` gives static replicas of the panel and of Slack (`src/components/ui/`, styled by `src/styles/ui.css`); they look like the panel in both themes and never run code.

| Component                                                                                                                                                                        | Use                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `<Screen title="A › B" caption kind>`                                                                                                                                            | The frame: "In the panel · A › B". `kind="example"` for anything that is not the panel. |
| `<Toolbar title crumbs>`                                                                                                                                                         | A page or card header; children go to the right, `slot="start"` right after the title.  |
| `<Strip items={[{ value, label, tone }]} end>`                                                                                                                                   | The counts row under a toolbar. `tone`: `ok`, `warn`, `bad`.                            |
| `<Scroll>`                                                                                                                                                                       | Wraps a markdown table inside a screen so it scrolls on narrow pages.                   |
| `<Tag tone mono>`                                                                                                                                                                | Status chips. `tone`: `ok`, `warn`, `bad`, `info`, `acc`.                               |
| `<Button primary ghost>`                                                                                                                                                         | A button as drawn (not clickable).                                                      |
| `<Ui>Measure now</Ui>`                                                                                                                                                           | A control named in prose.                                                               |
| `<Kbd>J</Kbd>`                                                                                                                                                                   | A key.                                                                                  |
| `<Meter value tone label>`                                                                                                                                                       | A budget or share bar; tone follows the value unless given.                             |
| `<Ticks healthy warnings failing none>`                                                                                                                                          | The fleet health ticks.                                                                 |
| `<Tabs items active>`, `<Segmented items active>`                                                                                                                                | Underline tabs and segmented switches; `'Findings:3'` adds a count.                     |
| `<Sheet id title position>`                                                                                                                                                      | A side sheet; `slot="tags"` and `slot="actions"` go in its header.                      |
| `<Facts items={[[label, value]]}>`                                                                                                                                               | The key–value list of a sheet or card.                                                  |
| `<Fields columns>`, `<Field label value placeholder hint mono toggle wide>`                                                                                                      | A settings form.                                                                        |
| `<Rows>`, `<Row title sub selected>`                                                                                                                                             | A list of rows; extra children go to the right.                                         |
| `<Stack>`, `<Split>`                                                                                                                                                             | Padding with vertical spacing; two panes side by side.                                  |
| `<Diff file stat lines>`, `<Comment severity where>`                                                                                                                             | A diff and a review comment by Holtkeeper.                                              |
| `<SlackWindow channel topic channels>`, `<SlackMessage author time color>`, `<SlackHeader>`, `<SlackContext>`, `<SlackReactions>`, `<SlackReaction emoji count>`, `<Emoji name>` | Slack, with the app's avatar and status emoji from `holtkeeper/.github`.                |
| `<Cards>`, `<Card title href icon>`                                                                                                                                              | Links to related pages; `icon` is a rail icon name.                                     |

Markdown tables inside a `Screen` get the panel's compact table style. Leave a blank line before and after markdown inside a component.

Do not use Starlight's `<Steps>`, `<Tabs>` or `<FileTree>`: they load a native module that the build cannot resolve under Bun's isolated installs. Write procedures as numbered lists and alternatives as `###` subheadings; asides (`:::note`, `:::tip`, `:::caution`) work.

The MDX compiler mis-slices a markdown list that follows an indented component with an expression attribute inside another component (`<Stack>`, then `  <Facts items={…} />`, then `- item`): the build fails with `Parse error`. Inside components, write such lists as `<ul><li>` or move them out.

## Landing

`src/pages/index.astro` assembles `src/components/landing/*`: the hero with the product tour (a small inline script switches the slides), the workspaces, the flow, agents, sizes, contracts and deploy sections. Colors are the Graphite tokens in `src/styles/theme.css`; the landing's own layout is in `src/styles/landing.css`. Both pages share Starlight's `starlight-theme` key in `localStorage`; with nothing stored the site is dark.

## Checks

`astro check` refuses TypeScript 7, which the repository pins, so type-check the TypeScript files with `tsc -p docs/tsconfig.json` and rely on `astro build` for `.astro` and `.mdx` files.
