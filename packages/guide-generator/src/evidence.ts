import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { CommitConventions } from '@holtkeeper/commit-conventions'
import { type CoverageData, percentOf } from '@holtkeeper/coverage'
import { detectTestSetup, isTestFile } from '@holtkeeper/quality-tests'
import { type TestIdsData, attributeUsage } from '@holtkeeper/testids'
import { detectToolchain } from '@holtkeeper/toolchain'

/**
 * One deterministic fact about a repository the generator reads. Collectors never dump code: the
 * only source text is the head of at most three test files. The same checkout gives the same items.
 */
export interface Evidence {
  /** Unique within a section, e.g. `manifests` or `test-head:src/a.test.ts`. */
  id: string
  label: string
  text: string
}

const ITEM_CHARS = 1_500
const HEAD_LINES = 30
const HEAD_SAMPLES = 3

const clip = (text: string, max = ITEM_CHARS) =>
  text.length <= max ? text : `${text.slice(0, max - 4).trimEnd()}\n...`

const item = (id: string, label: string, lines: readonly string[]): Evidence[] => {
  const text = lines.filter(Boolean).join('\n').trim()
  return text ? [{ id, label, text: clip(text) }] : []
}

/**
 * `count` rounded to two significant digits above 100, so evidence (and its hash) does not change
 * with every file added.
 */
export function approx(count: number): string {
  if (count < 100) return String(count)
  const magnitude = 10 ** (Math.floor(Math.log10(count)) - 1)
  const rounded = Math.round(count / magnitude) * magnitude
  return rounded >= 1000
    ? `~${(rounded / 1000).toFixed(rounded >= 10_000 ? 0 : 1)}k`
    : `~${rounded}`
}

async function readText(dir: string, file: string, limit = 64 * 1024) {
  try {
    const text = await readFile(join(dir, file), 'utf8')
    return text.length > limit ? text.slice(0, limit) : text
  } catch {
    return undefined
  }
}

const readMakefile = async (dir: string) =>
  (await readText(dir, 'Makefile')) ?? (await readText(dir, 'GNUmakefile'))

async function names(dir: string, folder: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, folder))).toSorted()
  } catch {
    return []
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    try {
      const value: unknown = JSON.parse(
        text.replaceAll(/^\s*\/\/.*$/gm, '').replaceAll(/,(\s*[}\]])/g, '$1'),
      )
      return isRecord(value) ? value : undefined
    } catch {
      return undefined
    }
  }
}

function parseYaml(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    const value: unknown = Bun.YAML.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

const depth = (file: string) => file.split('/').length - 1
const base = (file: string) => file.slice(file.lastIndexOf('/') + 1)
const short = (text: string, max = 120) =>
  text.length <= max ? text : `${text.slice(0, max - 3)}...`

const scriptsOf = (manifest: Record<string, unknown>): [string, string][] =>
  isRecord(manifest.scripts)
    ? Object.entries(manifest.scripts).flatMap(([name, command]) =>
        typeof command === 'string' ? [[name, command] as [string, string]] : [],
      )
    : []

const dependencyNames = (manifest: Record<string, unknown>) =>
  ['dependencies', 'devDependencies', 'peerDependencies']
    .flatMap((field) => {
      const value = manifest[field]
      return isRecord(value) ? Object.keys(value) : []
    })
    .toSorted()

const isEcho = (line: string) => /^@?(echo|printf)\b/.test(line)

/** Make targets with the first line of their recipe that is not an `echo`. */
export function makeTargets(text: string): [string, string][] {
  const targets: [string, string][] = []
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    const match = /^([A-Za-z0-9][\w.-]*)\s*:(?!=)/.exec(line)
    if (!match?.[1] || match[1] === '.PHONY') continue
    let recipe = ''
    for (let next = index + 1; lines[next]?.startsWith('\t'); next++) {
      const command = lines[next]!.trim()
      if (command && !isEcho(command)) {
        recipe = command
        break
      }
    }
    targets.push([match[1], recipe])
  }
  return targets
}

const KEY_TARGETS =
  /^(test|tests|unit|integration|e2e|lint|vet|fmt|format|check|build|run|generate|gen|mocks?|tidy|cover(age)?)([-_.].*)?$/

/** `targets` with the ones agents most need (test, lint, build, run, generate, ...) first, each group in file order. */
export function keyTargetsFirst(targets: readonly [string, string][]): [string, string][] {
  return [
    ...targets.filter(([name]) => KEY_TARGETS.test(name)),
    ...targets.filter(([name]) => !KEY_TARGETS.test(name)),
  ]
}

/** `use` directories and the `go` line of a `go.work`, on one line. */
export function goWorkSummary(text: string): string {
  const go = /^go\s+(\S+)/m.exec(text)?.[1]
  const uses: string[] = []
  const block = /^use\s*\(([^)]*)\)/m.exec(text)?.[1]
  for (const line of (block ?? '').split('\n')) {
    const use = line
      .replace(/\/\/.*$/, '')
      .trim()
      .split(/\s+/)[0]
    if (use) uses.push(use)
  }
  for (const match of text.matchAll(/^use\s+([^\s(]\S*)/gm)) if (match[1]) uses.push(match[1])
  return `go.work${go ? `, go ${go}` : ''}${uses.length ? `, use: ${uses.slice(0, 15).join(', ')}` : ''}`
}

function goModule(text: string): string[] {
  const module = /^module\s+(\S+)/m.exec(text)?.[1]
  const go = /^go\s+(\S+)/m.exec(text)?.[1]
  const requires = [...text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/\S+)\s+v\S+(.*)$/gm)]
    .filter((match) => !match[2]?.includes('// indirect'))
    .map((match) => match[1] ?? '')
  return [
    `module ${module ?? '?'}${go ? `, go ${go}` : ''}`,
    requires.length
      ? `direct requirements (${requires.length}): ${requires.slice(0, 15).join(', ')}`
      : '',
  ]
}

async function manifests(dir: string, files: readonly string[]): Promise<Evidence[]> {
  const lines: string[] = []
  const root = parseJson(await readText(dir, 'package.json'))
  if (root) {
    const scripts = scriptsOf(root)
    const workspaces = Array.isArray(root.workspaces)
      ? root.workspaces
      : isRecord(root.workspaces) && Array.isArray(root.workspaces.packages)
        ? root.workspaces.packages
        : []
    const deps = dependencyNames(root)
    lines.push(
      `package.json: ${typeof root.name === 'string' ? root.name : '(no name)'}${typeof root.packageManager === 'string' ? `, packageManager ${root.packageManager}` : ''}${typeof root.type === 'string' ? `, type ${root.type}` : ''}`,
      workspaces.length ? `  workspaces: ${workspaces.map(String).join(', ')}` : '',
      ...scripts.slice(0, 25).map(([name, command]) => `  script ${name}: ${short(command)}`),
      deps.length ? `  dependencies (${deps.length}): ${deps.slice(0, 30).join(', ')}` : '',
    )
  }
  const goMod = await readText(dir, 'go.mod')
  if (goMod) lines.push(`go.mod: ${goModule(goMod).filter(Boolean).join('; ')}`)
  const goWork = await readText(dir, 'go.work')
  if (goWork) lines.push(goWorkSummary(goWork))
  const makefile = await readMakefile(dir)
  if (makefile) {
    const targets = keyTargetsFirst(makeTargets(makefile))
    lines.push(
      `Makefile targets: ${targets
        .slice(0, 20)
        .map(([name, recipe]) => (recipe ? `${name} (${short(recipe, 60)})` : name))
        .join(', ')}`,
    )
  }
  const pyproject = await readText(dir, 'pyproject.toml')
  if (pyproject) {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1]
    const tools = [...pyproject.matchAll(/^\[tool\.([\w-]+)/gm)].map((match) => match[1])
    lines.push(
      `pyproject.toml: ${name ?? '(no name)'}${tools.length ? `, tools: ${[...new Set(tools)].join(', ')}` : ''}`,
    )
  }
  if (files.includes('Cargo.toml')) lines.push('Cargo.toml at the root')

  const nested = files
    .filter((file) => depth(file) > 0 && depth(file) <= 3)
    .filter((file) => ['package.json', 'go.mod', 'pyproject.toml'].includes(base(file)))
    .slice(0, 15)
  for (const file of nested) {
    // oxlint-disable-next-line no-await-in-loop -- at most 15 small files, in a stable order
    const text = await readText(dir, file)
    if (base(file) === 'go.mod') {
      lines.push(`${file}: ${text ? (goModule(text)[0] ?? '') : ''}`)
      continue
    }
    if (base(file) === 'pyproject.toml') {
      lines.push(file)
      continue
    }
    const manifest = parseJson(text)
    if (!manifest) continue
    const scripts = scriptsOf(manifest).map(([name]) => name)
    lines.push(
      `${file}: ${typeof manifest.name === 'string' ? manifest.name : '(no name)'}${scripts.length ? `, scripts: ${scripts.slice(0, 12).join(', ')}` : ''}`,
    )
  }
  return item('manifests', 'Manifests and scripts', lines)
}

const GITLAB_KEYS = new Set([
  'stages',
  'variables',
  'include',
  'default',
  'workflow',
  'image',
  'services',
  'before_script',
  'after_script',
  'cache',
  'pages',
])

const firstCommand = (script: unknown): string | undefined => {
  if (typeof script === 'string') return script
  if (Array.isArray(script)) return script.find((line) => typeof line === 'string')
  return undefined
}

/** One GitLab CI `include` entry as text: a project include names its files and ref. */
export function includeName(entry: unknown): string {
  if (typeof entry === 'string') return entry
  if (!isRecord(entry)) return ''
  if (typeof entry.project === 'string') {
    const files = (Array.isArray(entry.file) ? entry.file : [entry.file]).filter(
      (file): file is string => typeof file === 'string',
    )
    const ref = typeof entry.ref === 'string' ? `@${entry.ref}` : ''
    return `${entry.project}${files.length ? `:${files.join('+')}` : ''}${ref}`
  }
  const value = entry.local ?? entry.template ?? entry.remote ?? entry.component
  return typeof value === 'string' ? value : ''
}

function gitlabCi(text: string): string[] {
  const parsed = parseYaml(text)
  if (!parsed) {
    const jobs = [...text.matchAll(/^([A-Za-z0-9_][^:\n#]*):\s*$/gm)]
      .map((match) => match[1] ?? '')
      .filter((name) => !GITLAB_KEYS.has(name))
    return [`.gitlab-ci.yml jobs: ${jobs.slice(0, 25).join(', ')}`]
  }
  const stages = Array.isArray(parsed.stages) ? parsed.stages.map(String) : []
  const include = parsed.include
  const includes = (Array.isArray(include) ? include : include ? [include] : []).map(includeName)
  const templates = Object.keys(parsed)
    .filter((name) => name.startsWith('.') && isRecord(parsed[name]))
    .slice(0, 15)
  const jobs = Object.entries(parsed)
    .filter(([name, value]) => !GITLAB_KEYS.has(name) && !name.startsWith('.') && isRecord(value))
    .slice(0, 25)
    .map(([name, value]) => {
      const job = isRecord(value) ? value : {}
      const command = firstCommand(job.script)
      const extend = Array.isArray(job.extends) ? job.extends.join(', ') : job.extends
      return `  ${name}${typeof job.stage === 'string' ? ` (${job.stage})` : ''}${command ? `: ${short(command, 90)}` : typeof extend === 'string' ? `: extends ${extend}` : ''}`
    })
  return [
    `.gitlab-ci.yml${stages.length ? `, stages: ${stages.join(', ')}` : ''}`,
    includes.filter(Boolean).length ? `  includes: ${includes.filter(Boolean).join(', ')}` : '',
    templates.length ? `  job templates: ${templates.join(', ')}` : '',
    ...jobs,
  ]
}

function githubWorkflow(file: string, text: string): string[] {
  const parsed = parseYaml(text)
  if (!parsed) return [file]
  const on = parsed.on ?? parsed.true
  const events =
    typeof on === 'string' ? [on] : Array.isArray(on) ? on : isRecord(on) ? Object.keys(on) : []
  const jobs = isRecord(parsed.jobs) ? Object.entries(parsed.jobs) : []
  return [
    `${file}${typeof parsed.name === 'string' ? ` "${parsed.name}"` : ''}${events.length ? `, on: ${events.join(', ')}` : ''}`,
    ...jobs.slice(0, 10).map(([name, value]) => {
      const steps = isRecord(value) && Array.isArray(value.steps) ? value.steps : []
      const runs = steps
        .flatMap((step) => (isRecord(step) && typeof step.run === 'string' ? [step.run] : []))
        .map((run) => short(run.split('\n')[0] ?? '', 60))
        .slice(0, 5)
      return `  ${name}${runs.length ? `: ${runs.join('; ')}` : ''}`
    }),
  ]
}

async function ciConfig(dir: string, files: readonly string[]): Promise<Evidence[]> {
  const lines: string[] = []
  const gitlab = await readText(dir, '.gitlab-ci.yml')
  if (gitlab) lines.push(...gitlabCi(gitlab))
  const workflows = (await names(dir, '.github/workflows'))
    .filter((name) => /\.ya?ml$/.test(name))
    .slice(0, 6)
    .map((name) => `.github/workflows/${name}`)
  for (const file of workflows) {
    // oxlint-disable-next-line no-await-in-loop -- a few small files, in a stable order
    const text = await readText(dir, file)
    if (text) lines.push(...githubWorkflow(file, text))
  }
  for (const other of [
    'Jenkinsfile',
    '.circleci/config.yml',
    'azure-pipelines.yml',
    'bitbucket-pipelines.yml',
  ])
    // oxlint-disable-next-line no-await-in-loop -- four existence checks
    if (files.includes(other) || (await readText(dir, other, 1)) !== undefined)
      lines.push(`${other} present`)
  return item('ci', 'CI configuration', lines)
}

const LINT_CONFIGS: [RegExp, string][] = [
  [/^(\.eslintrc(\.[a-z]+)?|eslint\.config\.[cm]?[jt]s)$/, 'ESLint'],
  [/^\.?oxlintrc\.json$/, 'oxlint'],
  [/^\.oxfmtrc\.jsonc?$/, 'oxfmt'],
  [/^biome\.jsonc?$/, 'Biome'],
  [/^(\.prettierrc(\.[a-z]+)?|prettier\.config\.[cm]?[jt]s)$/, 'Prettier'],
  [/^(\.stylelintrc(\.[a-z]+)?|stylelint\.config\.[cm]?[jt]s)$/, 'Stylelint'],
  [/^\.golangci\.(ya?ml|toml|json)$/, 'golangci-lint'],
  [/^(ruff\.toml|\.ruff\.toml)$/, 'Ruff'],
  [/^\.editorconfig$/, 'EditorConfig'],
  [/^(commitlint\.config\.[cm]?[jt]s|\.commitlintrc(\.[a-z]+)?)$/, 'commitlint'],
  [/^(lefthook\.ya?ml|\.pre-commit-config\.yaml)$/, 'git hooks'],
  [/^knip\.jsonc?$/, 'knip'],
  [/^\.markdownlint(\.[a-z]+)?$/, 'markdownlint'],
]

const TS_OPTIONS = [
  'strict',
  'target',
  'module',
  'moduleResolution',
  'jsx',
  'noEmit',
  'allowImportingTsExtensions',
  'verbatimModuleSyntax',
  'erasableSyntaxOnly',
  'noUncheckedIndexedAccess',
  'baseUrl',
]

const stringList = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

/** What a golangci-lint config sets (v1 or v2): version, default set, enabled linters and formatters, build tags. */
export function golangciSummary(file: string, text: string): string {
  let parsed: Record<string, unknown> | undefined
  if (file.endsWith('.json')) parsed = parseJson(text)
  else if (file.endsWith('.toml')) {
    try {
      const value: unknown = Bun.TOML.parse(text)
      parsed = isRecord(value) ? value : undefined
    } catch {
      parsed = undefined
    }
  } else parsed = parseYaml(text)
  if (!parsed) return ''
  const linters = isRecord(parsed.linters) ? parsed.linters : {}
  const formatters = isRecord(parsed.formatters) ? parsed.formatters : {}
  const run = isRecord(parsed.run) ? parsed.run : {}
  const enabled = stringList(linters.enable)
  const disabled = stringList(linters.disable)
  const defaults =
    typeof linters.default === 'string'
      ? linters.default
      : linters['enable-all'] === true
        ? 'all'
        : linters['disable-all'] === true
          ? 'none'
          : undefined
  const parts = [
    typeof parsed.version === 'string' || typeof parsed.version === 'number'
      ? `version ${parsed.version}`
      : '',
    defaults ? `default ${defaults}` : '',
    enabled.length ? `linters: ${enabled.slice(0, 25).join(', ')}` : '',
    disabled.length ? `disabled: ${disabled.slice(0, 10).join(', ')}` : '',
    stringList(formatters.enable).length
      ? `formatters: ${stringList(formatters.enable).join(', ')}`
      : '',
    stringList(run['build-tags']).length
      ? `build tags: ${stringList(run['build-tags']).join(', ')}`
      : '',
  ].filter(Boolean)
  return parts.join('; ')
}

async function lintConfig(dir: string, files: readonly string[]): Promise<Evidence[]> {
  const lines: string[] = []
  for (const file of files.filter((path) => depth(path) === 0)) {
    const tool = LINT_CONFIGS.find(([pattern]) => pattern.test(file))?.[1]
    if (!tool) continue
    const summary =
      tool === 'golangci-lint'
        ? // oxlint-disable-next-line no-await-in-loop -- at most one golangci-lint config
          golangciSummary(file, (await readText(dir, file)) ?? '')
        : ''
    lines.push(`${tool}: ${file}${summary ? ` — ${summary}` : ''}`)
  }
  if ((await names(dir, '.husky')).length) lines.push('git hooks: .husky/')
  const manifest = parseJson(await readText(dir, 'package.json'))
  for (const key of ['lint-staged', 'prettier', 'eslintConfig', 'commitlint'])
    if (manifest && key in manifest) lines.push(`${key} config in package.json`)
  const tsconfig = parseJson(await readText(dir, 'tsconfig.json'))
  if (tsconfig) {
    const options = isRecord(tsconfig.compilerOptions) ? tsconfig.compilerOptions : {}
    const set = TS_OPTIONS.filter((key) => options[key] !== undefined).map(
      (key) => `${key}: ${JSON.stringify(options[key])}`,
    )
    const paths = isRecord(options.paths) ? Object.keys(options.paths) : []
    const references = Array.isArray(tsconfig.references) ? tsconfig.references.length : 0
    lines.push(
      `tsconfig.json${typeof tsconfig.extends === 'string' ? ` extends ${tsconfig.extends}` : ''}${set.length ? `: ${set.join(', ')}` : ''}`,
      paths.length ? `  path aliases: ${paths.slice(0, 10).join(', ')}` : '',
      references ? `  ${references} project references` : '',
    )
  }
  const nestedTs = files.filter((file) => depth(file) > 0 && base(file) === 'tsconfig.json').length
  if (nestedTs) lines.push(`${approx(nestedTs)} nested tsconfig.json files`)
  return item('lint', 'Lint, format and TypeScript config', lines)
}

async function toolchain(dir: string, files: readonly string[]): Promise<Evidence[]> {
  const detected = await detectToolchain(dir, files)
  return item('toolchain', 'Toolchain', [
    ...detected.tools.map((tool) => `${tool.name} ${tool.version} (from ${tool.source})`),
    detected.packageManager
      ? `package manager: ${detected.packageManager.name}${detected.packageManager.version ? ` ${detected.packageManager.version}` : ''}`
      : '',
    ...detected.notes.slice(0, 5),
  ])
}

const CONTAINERS = new Set([
  'packages',
  'apps',
  'libs',
  'services',
  'cmd',
  'internal',
  'src',
  'pkg',
])

function layout(files: readonly string[]): Evidence[] {
  const counts = new Map<string, number>()
  const children = new Map<string, Set<string>>()
  const rootFiles: string[] = []
  for (const file of files) {
    const [top, second] = file.split('/')
    if (!top) continue
    if (depth(file) === 0) {
      rootFiles.push(file)
      continue
    }
    counts.set(top, (counts.get(top) ?? 0) + 1)
    if (CONTAINERS.has(top) && second && depth(file) > 1)
      children.set(top, (children.get(top) ?? new Set()).add(second))
  }
  const dirs = [...counts].toSorted(([a], [b]) => a.localeCompare(b))
  return item('layout', 'Top-level layout', [
    ...dirs.slice(0, 30).map(([name, count]) => {
      const inner = [...(children.get(name) ?? [])].toSorted()
      return `${name}/ (${approx(count)} files)${inner.length ? `: ${inner.slice(0, 15).join(', ')}${inner.length > 15 ? `, +${inner.length - 15} more` : ''}` : ''}`
    }),
    rootFiles.length ? `root files: ${rootFiles.slice(0, 30).join(', ')}` : '',
  ])
}

const isDoc = (file: string) =>
  /\.(md|mdx|rst|adoc)$/i.test(file) &&
  (depth(file) === 0 ||
    /^docs?\//i.test(file) ||
    /^(AGENTS|CLAUDE|REVIEW|CONTRIBUTING|README)\.md$/i.test(base(file)))

async function docs(dir: string, files: readonly string[]): Promise<Evidence[]> {
  const found = files.filter(isDoc).filter((file) => depth(file) <= 3)
  const lines: string[] = []
  for (const file of found.slice(0, 40)) {
    // oxlint-disable-next-line no-await-in-loop -- at most 40 heads, in a stable order
    const head = await readText(dir, file, 2048)
    const title = head ? /^#\s+(.+)$/m.exec(head)?.[1]?.trim() : undefined
    lines.push(`${file}${title ? ` — ${short(title, 80)}` : ''}`)
  }
  if (found.length > 40) lines.push(`+${found.length - 40} more`)
  const folders = [
    ...new Set(
      files
        .filter((file) => /^docs?\//i.test(file))
        .flatMap((file) => {
          const parts = file.split('/')
          return Array.from({ length: Math.min(depth(file), 3) - 1 }, (_, index) =>
            parts.slice(0, index + 2).join('/'),
          )
        }),
    ),
  ].toSorted()
  if (folders.length)
    lines.push(
      `doc folders: ${folders.slice(0, 25).join(', ')}${folders.length > 25 ? `, +${folders.length - 25} more` : ''}`,
    )
  return item('docs', 'Existing docs (point to them, do not restate them)', lines)
}

/**
 * Evidence for the `general` section: manifests and scripts (package.json, go.mod, go.work,
 * Makefile targets with test/lint/build/run first), CI config (jobs, includes, job templates),
 * lint/format/TypeScript config (with a golangci-lint config's linters), toolchain, top-level
 * layout and the existing docs with their folders. `files` lists the checkout
 * (repository-relative), e.g. from `listFiles` of `@holtkeeper/quality-tests`.
 */
export async function collectGeneral(dir: string, files: readonly string[]): Promise<Evidence[]> {
  const all = [...files].toSorted()
  return [
    ...(await manifests(dir, all)),
    ...(await ciConfig(dir, all)),
    ...(await lintConfig(dir, all)),
    ...(await toolchain(dir, all)),
    ...layout(all),
    ...(await docs(dir, all)),
  ]
}

const TEST_SCRIPT = /test|spec|e2e|cov/i

const SOURCE_ROOTS = new Set(['src', 'packages', 'apps', 'internal', 'cmd', 'lib', 'libs', 'pkg'])

const folderOf = (file: string) => {
  const parts = file.split('/')
  if (parts.length <= 1) return '.'
  const [first, second] = parts
  return first && SOURCE_ROOTS.has(first) && parts.length > 2 && second
    ? `${first}/${second}`
    : (first ?? '.')
}

const band = (percent: number) => {
  const low = Math.min(90, Math.floor(percent / 10) * 10)
  return `${low}-${low + 10}%`
}

const roughLines = (count: number) => (count < 100 ? 'under 100' : approx(count))

function coverageLines(coverage: CoverageData): string[] {
  const total = percentOf(coverage.summary.lines)
  const folders = new Map<string, { covered: number; total: number }>()
  for (const file of coverage.files) {
    const key = folderOf(file.file)
    const sum = folders.get(key) ?? { covered: 0, total: 0 }
    sum.covered += file.lines.covered
    sum.total += file.lines.total
    folders.set(key, sum)
  }
  const ranked = [...folders]
    .filter(([, lines]) => lines.total > 0)
    .toSorted((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .slice(0, 12)
  return [
    `line coverage ${total === undefined ? 'unknown' : band(total)} of ${roughLines(coverage.summary.lines.total)} lines (${coverage.tools.join(', ')})`,
    ...ranked.map(
      ([folder, lines]) =>
        `  ${folder}: ${band(percentOf(lines) ?? 0)} of ${roughLines(lines.total)} lines`,
    ),
  ]
}

const GO_TAG_FILES = 400
const PLATFORM_TAGS =
  /^(linux|darwin|windows|freebsd|openbsd|netbsd|android|ios|js|wasip1|plan9|solaris|aix|unix|amd64|arm64|386|arm|wasm|riscv64|ppc64le|s390x|cgo|ignore|go1\.\d+)$/

/** Constraint names of a `//go:build` line that a test run would need `-tags` for (platform tags left out). */
export function buildTags(line: string): string[] {
  return [...line.matchAll(/(!?)([A-Za-z_][\w.]*)/g)]
    .filter((match) => !match[1] && match[2] !== 'go' && !PLATFORM_TAGS.test(match[2] ?? ''))
    .map((match) => match[2] ?? '')
}

async function goTestTags(dir: string, files: readonly string[]): Promise<string> {
  const counts = new Map<string, number>()
  const tests = files.filter((file) => file.endsWith('_test.go') && !/(^|\/)vendor\//.test(file))
  for (const file of tests.slice(0, GO_TAG_FILES)) {
    // oxlint-disable-next-line no-await-in-loop -- file heads only, in a stable order
    const head = await readText(dir, file, 2048)
    const line = head ? /^\/\/go:build\s+(.+)$/m.exec(head)?.[1] : undefined
    for (const tag of new Set(line ? buildTags(line) : []))
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  const ranked = [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return ranked.length
    ? `Go test files behind build tags (run with go test -tags): ${ranked
        .slice(0, 8)
        .map(([tag, count]) => `${tag} (${approx(count)} files)`)
        .join(', ')}`
    : ''
}

/**
 * Evidence for the `testing` section: the detected frameworks and conventions, the build tags Go
 * test files need, test scripts and Makefile targets, the first lines of up to three sample tests, and line coverage by folder when a coverage analysis
 * exists. Empty when the repository has no tests, no framework and no coverage.
 */
export async function collectTesting(
  dir: string,
  files: readonly string[],
  coverage?: CoverageData,
): Promise<Evidence[]> {
  const setup = await detectTestSetup(dir)
  if (!setup.testFiles && !setup.frameworks.length && !coverage) return []
  const scripts: string[] = []
  for (const file of files.filter((path) => base(path) === 'package.json' && depth(path) <= 2)) {
    // oxlint-disable-next-line no-await-in-loop -- a few small files, in a stable order
    const manifest = parseJson(await readText(dir, file))
    for (const [name, command] of manifest ? scriptsOf(manifest) : [])
      if (TEST_SCRIPT.test(name)) scripts.push(`${file} ${name}: ${short(command)}`)
  }
  const makefile = await readMakefile(dir)
  for (const [name, recipe] of makefile ? makeTargets(makefile) : [])
    if (TEST_SCRIPT.test(name)) scripts.push(`make ${name}${recipe ? `: ${short(recipe)}` : ''}`)

  const heads: Evidence[] = []
  const samples = setup.samples.length ? setup.samples : files.filter(isTestFile)
  for (const sample of samples.slice(0, HEAD_SAMPLES)) {
    // oxlint-disable-next-line no-await-in-loop -- at most three files
    const text = await readText(dir, sample, 16 * 1024)
    if (text)
      heads.push(
        ...item(`test-head:${sample}`, `Head of ${sample}`, [
          text.split('\n').slice(0, HEAD_LINES).join('\n'),
        ]),
      )
  }
  return [
    ...item('test-setup', 'Test frameworks and conventions', [
      `${approx(setup.testFiles)} test files`,
      ...setup.frameworks.map(
        (framework) =>
          `framework ${framework.framework} (${framework.language}): ${framework.evidence.slice(0, 3).join('; ')}`,
      ),
      ...setup.conventions.map(
        (conventions) =>
          `${conventions.language}: layout ${conventions.layout}${conventions.testDir ? ` (${conventions.testDir}/)` : ''}, file name ${conventions.fileName}${conventions.frameworkImport ? `, import \`${conventions.frameworkImport}\`` : ''}${conventions.localImportExtension ? `, local imports ${conventions.localImportExtension}` : ''}`,
      ),
      await goTestTags(dir, files),
    ]),
    ...item('test-scripts', 'Test commands', scripts.slice(0, 15)),
    ...heads,
    ...(coverage ? item('coverage', 'Coverage by folder', coverageLines(coverage)) : []),
  ]
}

const STYLES: [string, RegExp][] = [
  ['kebab-case', /^[a-z0-9]+(-[a-z0-9]+)+$/],
  ['camelCase', /^[a-z]+[a-z0-9]*([A-Z][a-z0-9]*)+$/],
  ['snake_case', /^[a-z0-9]+(_[a-z0-9]+)+$/],
  ['dotted', /^[a-z0-9]+(\.[a-zA-Z0-9-]+)+$/],
  ['PascalCase', /^([A-Z][a-z0-9]+)+$/],
  ['single word', /^[a-z0-9]+$/],
]

const styleOf = (value: string) => STYLES.find(([, pattern]) => pattern.test(value))?.[0] ?? 'other'

/**
 * Evidence for the `testids` section from a `testids` catalog: configured attributes and their use,
 * the naming style of literal values with a few real examples, and the elements that carry them.
 * Empty without a catalog or when nothing is tagged.
 */
export function collectTestIds(data: TestIdsData | undefined): Evidence[] {
  if (!data?.components.length) return []
  const usage = attributeUsage(data.components)
  const values = usage.flatMap((attribute) => attribute.values)
  const styles = new Map<string, string[]>()
  for (const value of values)
    styles.set(styleOf(value), [...(styles.get(styleOf(value)) ?? []), value])
  const ranked = [...styles].toSorted(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )
  let dynamic = 0
  let elements = 0
  const tags = new Map<string, number>()
  for (const component of data.components)
    for (const element of component.elements) {
      elements++
      if (element.attributes.some((attribute) => attribute.dynamic)) dynamic++
      const tag = element.tag.toLowerCase()
      tags.set(tag, (tags.get(tag) ?? 0) + 1)
    }
  const topTags = [...tags].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10)
  return [
    ...item('testids-attributes', 'Test attributes in use', [
      `configured attributes: ${data.attributes.join(', ')}`,
      ...usage
        .slice(0, 6)
        .map(
          (attribute) =>
            `${attribute.name}: ${approx(attribute.elements)} elements in ${approx(attribute.components)} components`,
        ),
    ]),
    ...item('testids-naming', 'Naming of literal values', [
      ...ranked
        .slice(0, 3)
        .map(
          ([style, list]) =>
            `${style}: ${Math.round((list.length / Math.max(values.length, 1)) * 100)}% of ${approx(values.length)} values, e.g. ${[...new Set(list)].toSorted().slice(0, 4).join(', ')}`,
        ),
      elements
        ? `${Math.round((dynamic / elements) * 100)}% of tagged elements use a bound value`
        : '',
    ]),
    ...item('testids-elements', 'Elements that carry test attributes', [
      topTags.map(([tag, count]) => `${tag} (${approx(count)})`).join(', '),
    ]),
  ]
}

const sourceNames = {
  setting: 'team setting',
  'push-rules': 'forge push rule',
  commitlint: 'commitlint',
  history: 'recent history',
} as const

const codes = (list: readonly string[]) => list.map((value) => `\`${value}\``).join(', ')

/**
 * The `commits` section as text, straight from commit-convention inference (no LLM): templates
 * and rules with where each came from. Examples and counts are left out so the text only changes
 * when a rule does. Empty when no rule was found.
 */
export function commitsText(conventions: CommitConventions): string {
  const { rules, sources } = conventions.commit
  const branch = conventions.branch.rules
  const from = (source: keyof typeof sources) => {
    const value = sources[source]
    return value ? ` _(${sourceNames[value]})_` : ''
  }
  const branchFrom = (source: keyof typeof conventions.branch.sources) => {
    const value = conventions.branch.sources[source]
    return value ? ` _(${sourceNames[value]})_` : ''
  }
  const lines = [
    rules.template &&
      `Write commit titles as \`${rules.template}\`${rules.conventional ? ' (Conventional Commits)' : ''}.${from('template')}`,
    rules.conventional &&
      !rules.template &&
      `Use Conventional Commits titles: \`type(scope): subject\`.${from('conventional')}`,
    rules.types?.length && `Use the commit types ${codes(rules.types)}.${from('types')}`,
    rules.scopes?.length &&
      `Use the scopes ${codes(rules.scopes)}${rules.scopeRequired ? '; a scope is required' : ''}.${from('scopes')}`,
    !rules.scopes?.length && rules.scopeRequired && `Always give a scope.${from('scopeRequired')}`,
    rules.ticket &&
      `${rules.ticket.required ? 'Put a ticket key' : 'When there is a ticket, put its key'} matching \`${rules.ticket.pattern}\` in ${rules.ticket.required ? 'every' : 'the'} title${rules.ticket.placement ? ` (${rules.ticket.placement})` : ''}.${from('ticket')}`,
    rules.maxLength && `Keep titles within ${rules.maxLength} characters.${from('maxLength')}`,
    rules.subjectCase && `Start the subject in ${rules.subjectCase} case.${from('subjectCase')}`,
    rules.noTrailingPeriod && `End titles without a period.${from('noTrailingPeriod')}`,
    rules.body === 'none' && `Write the title only, no body.${from('body')}`,
    rules.body === 'required' && `Always add a body.${from('body')}`,
    ...conventions.commit.patterns.map(
      (pattern) =>
        `Commit messages ${pattern.negative ? 'must not' : 'must'} match \`${pattern.pattern}\`. _(${sourceNames[pattern.source]})_`,
    ),
    branch.template && `Name branches \`${branch.template}\`.${branchFrom('template')}`,
    branch.prefixes?.length &&
      !branch.template &&
      `Start branch names with ${codes(branch.prefixes.map((prefix) => `${prefix}/`))}.${branchFrom('prefixes')}`,
    branch.case && `Write branch names in ${branch.case} case.${branchFrom('case')}`,
    ...conventions.branch.patterns.map(
      (pattern) =>
        `Branch names ${pattern.negative ? 'must not' : 'must'} match \`${pattern.pattern}\`. _(${sourceNames[pattern.source]})_`,
    ),
  ].filter((line): line is string => typeof line === 'string' && line.length > 0)
  return lines.map((line) => `- ${line}`).join('\n')
}
