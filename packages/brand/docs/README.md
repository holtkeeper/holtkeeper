# @holtkeeper/brand

The Holtkeeper mascot and capability icons as SVG, shared by the web UI and the docs site. The
originals live in [holtkeeper/.github](https://github.com/holtkeeper/.github) (`profile/assets/`);
copy them from there instead of editing them here.

| Import                               | What                                |
| ------------------------------------ | ----------------------------------- |
| `@holtkeeper/brand/holtkeeper.svg`   | The mascot: app icon, favicon, logo |
| `@holtkeeper/brand/avatar.svg`       | The mascot on its tile (org avatar) |
| `@holtkeeper/brand/review.svg`       | AI review                           |
| `@holtkeeper/brand/updates.svg`      | Dependency updates across the fleet |
| `@holtkeeper/brand/audit.svg`        | Vulnerability audit                 |
| `@holtkeeper/brand/browserslist.svg` | Browserslist updates                |
| `@holtkeeper/brand/release.svg`      | Releases and changelogs             |
| `@holtkeeper/brand/quality.svg`      | Code quality                        |
| `@holtkeeper/brand/bundles.svg`      | Bundle size                         |
| `@holtkeeper/brand/knowledge.svg`    | Knowledge agents read before tasks  |
| `@holtkeeper/brand/repos.svg`        | Repositories                        |
| `@holtkeeper/brand/credentials.svg`  | Credentials                         |
| `@holtkeeper/brand/coverage.svg`     | Test coverage                       |
| `@holtkeeper/brand/testids.svg`      | Test ids in frontend templates      |
| `@holtkeeper/brand/branches.svg`     | Branches to clean up                |
| `@holtkeeper/brand/ci.svg`           | CI job durations and failures       |
| `@holtkeeper/brand/licenses.svg`     | Dependency licenses                 |
| `@holtkeeper/brand/api.svg`          | Public API of packages              |
| `@holtkeeper/brand/fleet.svg`        | Fleet: shared versions and drift    |
| `@holtkeeper/brand/stack.svg`        | Tech stack and end of life          |

```ts
import auditIcon from '@holtkeeper/brand/audit.svg'
```

`apps/web/public/favicon.svg` and `docs/public/favicon.svg` are copies of `holtkeeper.svg`: favicons are
served as plain files, not bundled.
