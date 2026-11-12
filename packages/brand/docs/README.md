# @holtkeeper/brand

The Holtkeeper mascot as SVG, shared by the web UI and the docs site. The originals are rendered in
[holtkeeper/.github](https://github.com/holtkeeper/.github) (`scripts/render.py`, output in
`profile/assets/`); copy them from there instead of editing them here.

| Import                             | What                                                   |
| ---------------------------------- | ------------------------------------------------------ |
| `@holtkeeper/brand/holtkeeper.svg` | The mascot on a transparent background: logo, app icon |
| `@holtkeeper/brand/avatar.svg`     | The mascot on its Graphite tile (org and bot avatar)   |

```ts
import logo from '@holtkeeper/brand/holtkeeper.svg'
```

The mascot is an otter in driftwood brown (`#9c7a5e`) with a dark eye mask; the amber accent (`--brand`, `#f0a63a`) stays for the interface. `apps/web/public/favicon.svg`
and `docs/public/favicon.svg` are copies of `holtkeeper.svg`: the one favicon of both sites, served as
a plain file, not bundled.
