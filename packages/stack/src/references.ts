/** A parsed image reference, with Docker Hub defaults applied. */
export interface ImageRef {
  /** `docker.io`, `ghcr.io`, `registry.example.com:5000`. */
  registry: string
  /** `library/node`, `acme/base`. */
  repository: string
  tag?: string
  digest?: string
}

/** What a reference names in a file: an image, or a tool version from a CI setup action. */
export type Reference =
  | { type: 'image'; ref: string }
  | { type: 'tool'; tool: string; declared: string }

/** References found in one file; `unresolved` holds values with variables that could not be expanded. */
export interface References {
  references: Reference[]
  unresolved: string[]
}

const repositoryPattern = /^[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*$/

/** Parses `node:22-alpine`, `ghcr.io/acme/base:1.2@sha256:…`; `undefined` for anything else. */
export function parseImageRef(text: string): ImageRef | undefined {
  const value = text.trim()
  if (!value || /[\s$]/.test(value)) return undefined
  const [named = '', digest] = value.split('@', 2)
  const slash = named.lastIndexOf('/')
  const colon = named.lastIndexOf(':')
  const tag = colon > slash ? named.slice(colon + 1) : undefined
  const path = colon > slash ? named.slice(0, colon) : named
  const segments = path.split('/')
  const first = segments[0] ?? ''
  const hasRegistry =
    segments.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')
  const registry = hasRegistry ? first : 'docker.io'
  let repository = (hasRegistry ? segments.slice(1) : segments).join('/')
  if (registry === 'docker.io' && !repository.includes('/')) repository = `library/${repository}`
  if (!repositoryPattern.test(repository)) return undefined
  if (tag !== undefined && !/^[\w][\w.-]{0,127}$/.test(tag)) return undefined
  return { registry, repository, ...(tag ? { tag } : {}), ...(digest ? { digest } : {}) }
}

const tagPattern = /^v?(\d+(?:\.\d+){0,3})(?:[-_](.+))?$/

/** Splits a tag into a version and a variant: `22.11-alpine3.20` → `22.11` + `alpine3.20`. */
export function tagVersion(tag: string | undefined): { version?: string; variant?: string } {
  if (!tag) return {}
  const match = tagPattern.exec(tag)
  if (match?.[1]) return { version: match[1], ...(match[2] ? { variant: match[2] } : {}) }
  return tag === 'latest' ? {} : { variant: tag }
}

/** A variant without its versions, so `alpine3.20` and `alpine3.22` are the same family. */
export const variantFamily = (variant: string | undefined) =>
  (variant ?? '').replace(/\d+(?:\.\d+)*/g, '').replace(/[-_.]+$/, '')

/** Variants that mark prereleases, never offered as the latest. */
export const isPrerelease = (variant: string | undefined) =>
  variant !== undefined &&
  /^(rc|alpha|beta|dev|preview|nightly|canary|next|snapshot)/i.test(variant)

const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/, '$2')

const pattern = /\$\{\{\s*env\.(\w+)\s*\}\}|\$\{(\w+)(?::?-([^}]*))?\}|\$(\w+)/g

/** Expands `$VAR`, `${VAR}`, `${VAR:-default}` and `${{ env.VAR }}`, following variables that name others. */
export function expand(value: string, variables: Record<string, string>): string {
  let current = value
  for (let pass = 0; pass < 5 && current.includes('$'); pass++) {
    const next = current.replace(
      pattern,
      (whole, env?: string, braced?: string, fallback?: string, bare?: string) =>
        variables[env ?? braced ?? bare ?? ''] ?? fallback ?? whole,
    )
    if (next === current) break
    current = next
  }
  return current
}

/**
 * Images a Dockerfile builds from: every `FROM` except earlier stages and `scratch`, with `ARG`
 * defaults expanded.
 */
export function dockerfileReferences(text: string): References {
  const result: References = { references: [], unresolved: [] }
  const args: Record<string, string> = {}
  const stages = new Set<string>()
  for (const raw of text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [instruction = '', ...rest] = line.split(/\s+/)
    const upper = instruction.toUpperCase()
    if (upper === 'ARG') {
      for (const token of rest) {
        const [name = '', value] = token.split('=', 2)
        if (value !== undefined && !(name in args)) args[name] = unquote(value)
      }
      continue
    }
    if (upper !== 'FROM') continue
    const tokens = rest.filter((token) => !token.startsWith('--'))
    const image = expand(tokens[0] ?? '', args)
    const as = tokens[1]?.toLowerCase() === 'as' ? tokens[2]?.toLowerCase() : undefined
    if (image && image !== 'scratch' && !stages.has(image.toLowerCase())) {
      if (image.includes('$')) result.unresolved.push(tokens[0] ?? image)
      else result.references.push({ type: 'image', ref: image })
    }
    if (as) stages.add(as)
  }
  return result
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const setupActions: Record<string, { tool: string; input: string }> = {
  'actions/setup-node': { tool: 'node', input: 'node-version' },
  'actions/setup-go': { tool: 'go', input: 'go-version' },
  'actions/setup-python': { tool: 'python', input: 'python-version' },
  'actions/setup-java': { tool: 'java', input: 'java-version' },
  'oven-sh/setup-bun': { tool: 'bun', input: 'bun-version' },
  'denoland/setup-deno': { tool: 'deno', input: 'deno-version' },
  'pnpm/action-setup': { tool: 'pnpm', input: 'version' },
  'ruby/setup-ruby': { tool: 'ruby', input: 'ruby-version' },
}

const scalar = (value: unknown) =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined

/** `variables` (GitLab) or `env` (GitHub) of a YAML node as plain strings. */
export const variablesOf = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {}
  const variables: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value)) {
    const text = scalar(entry) ?? (isRecord(entry) ? scalar(entry.value) : undefined)
    if (text !== undefined) variables[name] = text
  }
  return variables
}

export interface YamlReferenceOptions {
  /** Variables the file's own top-level ones give way to, e.g. merged from a whole GitLab pipeline. */
  inherited?: Record<string, string>
  /** Variables that win over every YAML definition, e.g. the forge's CI/CD variables. */
  ci?: Record<string, string>
}

/**
 * Images and tool versions a parsed YAML document names: `image` keys (a string, GitLab's
 * `{ name }` or Helm's `{ registry?, repository, tag? }`), `services` lists, GitHub Actions
 * `container`, `docker://` steps and setup actions (`actions/setup-node` with `node-version`,
 * expanding `${{ matrix.* }}` lists). Variables expand with GitLab's precedence: `ci` over
 * `variables`/`env` of the job or step over the top-level ones over `inherited`.
 */
export function yamlReferences(document: unknown, options: YamlReferenceOptions = {}): References {
  const result: References = { references: [], unresolved: [] }
  const root = isRecord(document) ? document : {}
  const ci = options.ci ?? {}
  const top = { ...variablesOf(root.variables), ...variablesOf(root.env), ...options.inherited }

  const image = (value: string, variables: Record<string, string>) => {
    const expanded = expand(value.trim(), { ...variables, ...ci })
    if (!expanded) return
    if (expanded.includes('$')) result.unresolved.push(value)
    else result.references.push({ type: 'image', ref: expanded })
  }
  const imageValue = (value: unknown, variables: Record<string, string>) => {
    const text = scalar(value)
    if (text !== undefined) return image(text, variables)
    if (!isRecord(value)) return
    const name = scalar(value.name)
    if (name !== undefined) return image(name, variables)
    const repository = scalar(value.repository)
    if (repository === undefined) return
    const registry = scalar(value.registry)
    const tag = scalar(value.tag)
    image(`${registry ? `${registry}/` : ''}${repository}${tag ? `:${tag}` : ''}`, variables)
  }
  const tool = (
    name: string,
    value: unknown,
    matrix: Record<string, unknown>,
    variables: Record<string, string>,
  ) => {
    const raw = scalar(value)
    if (raw === undefined) return
    const text = expand(raw, { ...variables, ...ci })
    const key = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(text.trim())?.[1]
    if (key) {
      const values = matrix[key]
      for (const entry of Array.isArray(values) ? values : [values]) {
        const resolved = scalar(entry)
        if (resolved !== undefined)
          result.references.push({ type: 'tool', tool: name, declared: resolved })
        else result.unresolved.push(text)
      }
      return
    }
    if (text.includes('${{')) result.unresolved.push(text)
    else result.references.push({ type: 'tool', tool: name, declared: text })
  }

  const walk = (
    node: unknown,
    matrix: Record<string, unknown>,
    variables: Record<string, string>,
  ) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, matrix, variables)
      return
    }
    if (!isRecord(node)) return
    const strategy = isRecord(node.strategy) ? node.strategy : undefined
    const scope = strategy && isRecord(strategy.matrix) ? { ...matrix, ...strategy.matrix } : matrix
    const own =
      node === root
        ? variables
        : { ...variables, ...variablesOf(node.variables), ...variablesOf(node.env) }
    const uses = scalar(node.uses)
    if (uses?.startsWith('docker://')) image(uses.slice('docker://'.length), own)
    const action = uses ? setupActions[uses.split('@')[0] ?? ''] : undefined
    if (action && isRecord(node.with)) tool(action.tool, node.with[action.input], scope, own)
    for (const [key, value] of Object.entries(node)) {
      if (key === 'image') imageValue(value, own)
      else if (key === 'container' && typeof value === 'string') image(value, own)
      else if (key === 'services' && Array.isArray(value))
        for (const entry of value) imageValue(entry, own)
      if (key !== 'image' && key !== 'variables' && (isRecord(value) || Array.isArray(value)))
        walk(value, scope, own)
    }
  }
  walk(root, {}, top)
  return result
}

/** A GitLab `include` the analysis can follow: a file of this repository or of another project. */
export type CiInclude =
  | { type: 'local'; file: string }
  | { type: 'project'; project: string; file: string; ref?: string }

/**
 * `include` entries of a GitLab CI document: local files and files of other projects. Remote
 * URLs, templates and components are returned as `skipped`.
 */
export function ciIncludes(document: unknown): { includes: CiInclude[]; skipped: string[] } {
  const result: { includes: CiInclude[]; skipped: string[] } = { includes: [], skipped: [] }
  const raw = isRecord(document) ? document.include : undefined
  for (const entry of Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) {
    const text = scalar(entry)
    if (text !== undefined) {
      if (/^https?:\/\//.test(text)) result.skipped.push(text)
      else result.includes.push({ type: 'local', file: text.replace(/^\/+/, '') })
      continue
    }
    if (!isRecord(entry)) continue
    const local = scalar(entry.local)
    const project = scalar(entry.project)
    if (local !== undefined)
      result.includes.push({ type: 'local', file: local.replace(/^\/+/, '') })
    else if (project !== undefined) {
      const ref = scalar(entry.ref)
      const files = Array.isArray(entry.file) ? entry.file : [entry.file]
      for (const file of files) {
        const path = scalar(file)
        if (path !== undefined)
          result.includes.push({
            type: 'project',
            project,
            file: path.replace(/^\/+/, ''),
            ...(ref ? { ref } : {}),
          })
      }
    } else {
      const other = scalar(entry.remote) ?? scalar(entry.template) ?? scalar(entry.component)
      if (other !== undefined) result.skipped.push(other)
    }
  }
  return result
}

const nameVersionPattern =
  /^(node|nodejs|bun|deno|go|golang|python|ruby|php|java|jdk|openjdk|temurin|rust|postgres|postgresql|redis|nginx|alpine|ubuntu|debian)[-_]?v?(\d+(?:[-._]\d+){0,2})(?:[-_.](.+))?$/i

const nameAliases: Record<string, string> = {
  nodejs: 'node',
  golang: 'go',
  jdk: 'java',
  openjdk: 'java',
  temurin: 'java',
  postgresql: 'postgres',
}

/**
 * A tool version written into an image name, as in-house base images do: `bun-1-3-slim` →
 * `bun` `1.3` + `slim`, `node-22-alpine-build-tools` → `node` `22` + `alpine-build-tools`.
 */
export function nameVersion(
  repository: string,
): { tool: string; version: string; variant?: string } | undefined {
  const match = nameVersionPattern.exec(repository.split('/').at(-1) ?? '')
  if (!match?.[1] || !match[2]) return undefined
  const name = match[1].toLowerCase()
  return {
    tool: nameAliases[name] ?? name,
    version: match[2].replace(/[-_]/g, '.'),
    ...(match[3] ? { variant: match[3] } : {}),
  }
}
