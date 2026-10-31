# @holtkeeper/stack

The tech stack of a config group: which runtimes, package managers, service and base images and other tools every repository uses, in which versions, how far they are behind the latest release and whether their release line is still supported. Everything is read through the forge API (`getRepository`, `listFiles`, `readFile`); nothing is cloned.

## Analyzer

`stackAnalyzer` (kind `stack`, scope `group`, needs `forge`) and `createStackAnalyzer({ sources? })` to inject `VersionSources` (called once per run). The record's repo is `{ forge, path: <group> }`. The default `stack-weekly` schedule runs it on Monday nights.

Options (`stackOptionsSchema`):

| Option     | Default | Meaning                                                                                                                               |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ignore`   | `[]`    | Component ids or names to leave out, `*` matches anything: `go`, `image:registry.example.com/*`. A flag takes a comma-separated list. |
| `soonDays` | `180`   | Days before an end of life that count as soon.                                                                                        |
| `maxFiles` | `50`    | Image, compose, CI and deployment files read per repository, shallowest first; the rest become a note.                                |
| `lookups`  | `true`  | Look up latest versions and release lines online; `false` only collects what repositories use.                                        |

## What is read per repository

The repository's file list comes from one recursive `listFiles`; without it only root files are read (`Dockerfile`, compose files, `.gitlab-ci.yml`) besides the root version files.

- **Version files** through `detectToolchainFrom` of [@holtkeeper/toolchain](../../toolchain/docs/README.md), for the root and every sub-project separately, so a monorepo with two Node versions shows both. Defaults implied by a lockfile or `package.json` count only for the root, as unpinned usages. `packageManager: npm@x` adds `npm`.
- **Dockerfiles** (`Dockerfile`, `Dockerfile.*`, `*.dockerfile`, `Containerfile`): every `FROM` with `ARG` defaults expanded, except `scratch` and earlier stages.
- **Compose files** (`compose.yml`, `docker-compose.*.yaml`, ...), **CI** (`.gitlab-ci.yml`, YAML under `.gitlab/`, `.github/workflows/*`) and **deployment** YAML (Helm `values*.yaml`, YAML under `k8s`, `kubernetes`, `manifests`, `deploy`, `deployment`, `helm`, `charts`, never under `templates`): `image` keys (a string, GitLab's `{ name }`, Helm's `{ registry?, repository, tag? }`), `services` lists, GitHub `container` and `docker://` steps. Setup actions add tool versions: `actions/setup-node` (`node-version`), `setup-go`, `setup-python`, `setup-java`, `oven-sh/setup-bun`, `denoland/setup-deno`, `pnpm/action-setup`, `ruby/setup-ruby`; `${{ matrix.x }}` expands to every value of the job's matrix. Variables expand with GitLab's precedence: forge CI/CD variables over job or step `variables`/`env` over top-level ones; values still holding variables become notes, and when the token could not read some CI/CD variables one note says for how many repositories and which groups.

**GitLab pipelines** are read as GitLab assembles them. `.gitlab-ci.yml` and its `include`s (local files, globs such as `packages/*/.gitlab-ci.yml`, and files of other projects on the same forge, at most four levels and 30 files) form one pipeline whose top-level `variables` merge, the including file winning; files of other projects are read once per run and their images count for the including repository (shown as `project:file`). Other GitLab CI files (child pipelines, YAML under `.gitlab/`) are read with their own includes and receive the root pipeline's variables. Remote, template and component includes are noted and skipped. CI/CD variables come from `GitForge.listCiVariables`: every group above the repository from the top down (each group read once per run), then the repository's own, `*`-scoped values first, over GitLab's predefined `CI_PROJECT_PATH`, `CI_PROJECT_NAME`, `CI_PROJECT_NAMESPACE`, `CI_PROJECT_ROOT_NAMESPACE` and `CI_DEFAULT_BRANCH`. They are only used to expand references; no value is stored except the image references they expand into.

Directories named `node_modules`, `vendor`, `target`, `dist`, `build`, `out`, `fixtures`, `__fixtures__`, `testdata` and dot directories other than `.github` and `.gitlab` are skipped.

## Components

A usage's `version` keeps the precision it was written with (`22`, `3.12`, `1.23.4`); `latest`, `lts`, a missing tag or a digest leave it out (unpinned). Image tags split into a version and a variant (`22.11-alpine3.20` → `22.11` + `alpine3.20`).

In-house images that write a tool version into their name join that tool: `baseimages/bun-1-3-slim` is `bun` `1.3` with variant `slim`, `node-22-alpine-build-tools` is `node` `22` (`nameVersion`).

Official images of known products join the matching tool: `node` images and `.nvmrc` are both `node`, `golang` is `go`, `eclipse-temurin` is `java`, `postgres` and `postgis/postgis` are `postgres`. `catalog.ts` holds the list (`toolComponent`, `imageComponent`). Kinds: `runtime`, `package-manager`, `service`, `os`, `image` (any other image, id `image:<name>`) and `tool` (any other mise tool).

Where the latest version comes from (`VersionSources`; `createHttpSources({ fetch?, ... })` caches per instance and answers `undefined` on failures):

| Lookup         | Components                                                                                                                                                                            | Gives                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| endoflife.date | node, go, python, ruby, php, java (Temurin), rust, postgres, mysql, mariadb, mongodb, redis, valkey, nginx, rabbitmq, elasticsearch, haproxy, traefik, docker, alpine, debian, ubuntu | release lines with end of life and LTS dates; `latest` is the newest release of any line, `latestLts` the newest of a supported LTS line |
| npm            | bun, npm, pnpm, yarn (`@yarnpkg/cli-dist`)                                                                                                                                            | `dist-tags.latest`                                                                                                                       |
| PyPI           | poetry, uv                                                                                                                                                                            | latest release                                                                                                                           |
| image tags     | deno and every other image                                                                                                                                                            | the newest release tag (no prereleases) in the variant family most usages use, plain tags first                                          |

Docker Hub tags come from its API (three pages of 100, newest first); images of other registries are first asked of the forge (`GitForge.listImageTags`, e.g. GitLab's container registry with the forge token), then the OCI distribution API with an anonymous token when challenged (up to ten pages of 1000). Registries neither can read (private registries of other forges, Amazon ECR) answer nothing and the component's latest version stays unknown.

## Assessment

Pure helpers, all judged at the record's `checkedAt`:

- `lagOf(version, latest)` compares only the parts a version names: a floating `22` is `current` while the latest is any `22.x`; otherwise `patch`, `minor`, `major` or `ahead`.
- `matchCycle(version, cycles)` — the longest release line prefixing the version (`1.23.4` → `1.23`), else the newest line it prefixes (a floating `3` → the newest `3.x`).
- `supportOf(cycle, at, soonDays)` — `eol`, `eol-soon`, `lts`, `active` or `unknown`.
- `assessUsage` combines them, with `cycleLatest` when a pinned version is behind its own line.
- `summarizeComponent` / `summarizeStack` — per repository the most worrying usage (end of life, then end of life soon, then the largest lag; pinned before floating), release lines in use with their repositories, and repositories on end of life, ending soon, behind a major and unpinned. `stackTotals` gives the headline numbers.

## Data

```ts
interface StackData {
  group: string
  checkedAt: string // ISO 8601
  soonDays: number
  repos: { path; webUrl?; files: string[]; error?; archived? }[]
  components: {
    id: string // 'node', 'postgres', 'image:ghcr.io/acme/base'
    name: string
    kind: 'runtime' | 'package-manager' | 'service' | 'os' | 'image' | 'tool'
    latest?: string
    latestLts?: string
    source?: string // 'endoflife.date/nodejs', 'npm/pnpm', 'ghcr.io/acme/base'
    cycles?: { cycle; releaseDate?; eol: string | boolean; lts?: string | boolean; latest? }[]
    usages: {
      repo
      file
      via: 'version-file' | 'dockerfile' | 'compose' | 'ci' | 'deploy'
      declared
      version?
      variant?
      image?
    }[]
  }[]
  notes: { repo?; message }[]
}
```

`stackDataSchema` validates it.

## Report

`stackAnalysis` (kind `stack`, label `Tech stack`).

- Metrics with deltas: repositories, components, repositories on end-of-life versions, with end of life soon, behind a major, components in several majors, unpinned versions.
- **End of life**: issues for release lines in use that have ended or end soon, with the repositories and the upgrade target (`new` / `resolved` against the previous record), and a timeline of the end of life of every line in use.
- **Versions**: one matrix of repositories × components per kind (the 40 most used components; only repositories that use one; image columns are shortened to the trailing path segments that keep them apart, with the full name as the header hint; the tone is end of life first, then lag) and a stacked chart of the spread per component.
- **Components**: latest, latest LTS, versions and release lines in use, counts per status, grouped by kind.
- **Map**: a grouped graph linking repositories to the release lines they use, so repositories on the same line meet at one node that lists its support and the versions written; above 300 links it keeps components several repositories share.
- **Where versions are set**: every usage with its file and source (first 1000).
- **Notes**: unreadable or archived repositories, unparsable files, unexpanded variables, unknown latest versions.

## Limitations

- Kubernetes manifests are read only from the directories above; Helm templates and Kustomize overlays are not rendered.
- Image tags that are code names (`bookworm`, `noble`) carry no version and count as unpinned.
- Versions YAML parsed as numbers lose trailing zeros (`python-version: 3.10` reads as `3.1`); quote them.
