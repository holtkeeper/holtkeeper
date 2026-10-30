# Website

The public site and documentation at https://holtkeeper.github.io: an Astro project with Starlight for the docs and a custom landing page.

```sh
bun run docs:dev     # from the repository root
bun run docs:build   # writes docs/dist
```

## Where pages come from

The site renders the repository's markdown where it lives; nothing is copied.

| Source                                          | Route             |
| ----------------------------------------------- | ----------------- |
| `src/content/docs/**` (hand-written pages only) | same path         |
| `docs/PLAN.md`, `docs/development.md`, ...      | `/guide/<name>/`  |
| `docs/README.md`                                | `/modules/`       |
| `apps/<dir>/docs/README.md`                     | `/modules/<dir>/` |
| `packages/<dir>/docs/README.md`                 | `/modules/<dir>/` |

- `src/docs/sources.ts` discovers the files, assigns routes and builds the sidebar. A new module needs no change here: its README is picked up and grouped by `src/docs/groups.ts` (by name, then by prefix; unknown modules land in "Other").
- `src/docs/loader.ts` is the `docs` collection loader. These files have no frontmatter: the first `# H1` becomes the title and is removed from the body, the first paragraph becomes the description, and "Edit page" points at the file on GitHub.
- `src/docs/links.ts` rewrites relative links while the markdown is rendered: links between rendered files become site routes (anchors kept), links to anything else become GitHub URLs on `main`.

## Landing

`src/pages/index.astro` assembles `src/components/landing/*`. The only hydrated island is the "how it works" pipeline (`pipeline/Pipeline.tsx`, React + Motion, `client:visible`); the terminal demo, copy buttons and theme toggle are small inline scripts. Terminal output follows the CLI's own formatters (`formatReport`, `formatReportText`); keep `minute.ts` in step when they change.

Colors are tokens in `src/styles/landing.css` (landing) and `src/styles/theme.css` (Starlight), each with a light variant under `[data-theme='light']`. Both pages share Starlight's `starlight-theme` key in `localStorage`; with nothing stored the site is dark.

## Checks

`astro check` refuses TypeScript 7, which the repository pins, so type-check the TypeScript files with `tsc -p docs/tsconfig.json` and rely on `astro build` for `.astro` files.
