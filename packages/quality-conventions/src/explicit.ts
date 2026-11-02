import { join } from 'node:path'

/** What part of the names an explicit rule decides. */
export type RuleScope = 'identifiers' | 'file names'

/**
 * A naming rule the project states in a tool's config. It covers the files under `dir` (`''`
 * for the whole project) written in one of `languages`, or in any language when it is absent.
 */
export interface ExplicitRule {
  tool: string
  dir: string
  scope: RuleScope
  languages?: readonly string[]
  /** Kind ids (`class`, `local-variable`, ...) the rule decides; every kind when absent. */
  kinds?: readonly string[]
}

type Found = Omit<ExplicitRule, 'tool' | 'dir'>

interface Detector {
  tool: string
  files: RegExp
  find(text: string): Found[]
}

const SCRIPT = ['typescript', 'javascript'] as const

/** Where the first mention of `rule` with a value other than `off` or `0` ends, if any. */
const enabledAt = (text: string, rule: string): number | undefined => {
  const escaped = rule.replaceAll(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`)
  const mention = new RegExp(
    String.raw`["']?(?:[\w@-]+/)?${escaped}["']?\s*[:=]\s*(\[?\s*\S*)`,
    'g',
  )
  const match = [...text.matchAll(mention)].find(
    (candidate) => !/^\[?\s*["']?(?:off|0)\b/.test(candidate[1] ?? ''),
  )
  return match ? match.index + match[0].length : undefined
}

const VARIABLES = ['module-constant', 'module-variable', 'local-variable', 'component']
const TYPES = ['class', 'type', 'enum']

/** typescript-eslint `naming-convention` selectors and the kinds they decide. */
const SELECTOR_KINDS: Readonly<Record<string, readonly string[]>> = {
  variableLike: [...VARIABLES, 'function'],
  variable: VARIABLES,
  function: ['function', 'component'],
  typeLike: TYPES,
  class: ['class'],
  interface: ['type'],
  typeAlias: ['type'],
  enum: ['enum'],
  enumMember: ['enum-member'],
  memberLike: ['method', 'enum-member'],
  method: ['method'],
  classMethod: ['method'],
  objectLiteralMethod: ['method'],
  typeMethod: ['method'],
}

/**
 * Kinds the `naming-convention` options after `from` decide. Without options, or with
 * `default` or selectors that cannot be read from the text, the defaults apply to every kind.
 */
function selectorKinds(text: string, from: number): readonly string[] | undefined {
  const selectors = [
    ...text.slice(from).matchAll(/["']?selector["']?\s*:\s*(\[[^\]]*\]|["'][^"']*["'])/g),
  ].flatMap((match) =>
    [...(match[1] ?? '').matchAll(/["'](\w+)["']/g)].map((name) => name[1] ?? ''),
  )
  const known = selectors.filter((name) => name === 'default' || name in SELECTOR_KINDS)
  if (!known.length || known.includes('default')) return undefined
  return [...new Set(known.flatMap((name) => SELECTOR_KINDS[name] ?? []))]
}

const fileNameRule = (text: string, rules: string[]): Found[] =>
  rules.some((rule) => enabledAt(text, rule) !== undefined)
    ? [{ scope: 'file names', languages: SCRIPT }]
    : []

const lintRules = (text: string): Found[] => {
  const at = enabledAt(text, 'naming-convention')
  const kinds = at === undefined ? undefined : selectorKinds(text, at)
  return [
    ...(at === undefined
      ? []
      : [{ scope: 'identifiers' as const, languages: SCRIPT, ...(kinds ? { kinds } : {}) }]),
    ...fileNameRule(text, ['filename-case', 'filename-naming-convention']),
  ]
}

const DETECTORS: readonly Detector[] = [
  {
    tool: 'eslint',
    files: /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.(?:json|[cm]?js|ya?ml))?|package\.json)$/,
    find: lintRules,
  },
  {
    tool: 'oxlint',
    files: /^(?:\.oxlintrc\.json|oxlint\.json|oxlint\.config\.[cm]?ts)$/,
    find: lintRules,
  },
  {
    tool: 'biome',
    files: /^biome\.jsonc?$/,
    find: (text) => [
      ...(enabledAt(text, 'useNamingConvention') === undefined
        ? []
        : [{ scope: 'identifiers' as const, languages: SCRIPT }]),
      ...fileNameRule(text, ['useFilenamingConvention']),
    ],
  },
  {
    tool: 'ls-lint',
    files: /^\.ls-lint\.ya?ml$/,
    find: () => [{ scope: 'file names' }],
  },
  {
    tool: 'ruff',
    files: /^(?:\.?ruff\.toml|pyproject\.toml)$/,
    find: (text) =>
      (!text.includes('[tool.') || text.includes('[tool.ruff')) &&
      /(?:^|\n)\s*(?:extend-)?select\s*=\s*\[[^\]]*["'](?:N\d*|ALL)["']/.test(text)
        ? [{ scope: 'identifiers', languages: ['python'] }]
        : [],
  },
]

/**
 * Naming rules the project already enforces with a linter (ESLint, oxlint, Biome, ls-lint, Ruff),
 * found in their config files among `paths`. Rules that are switched off are not returned.
 */
export async function explicitRules(
  dir: string,
  paths: readonly string[],
): Promise<ExplicitRule[]> {
  const rules: ExplicitRule[] = []
  for (const path of paths) {
    const slash = path.lastIndexOf('/')
    const base = path.slice(slash + 1)
    const detector = DETECTORS.find((candidate) => candidate.files.test(base))
    if (!detector || path.split('/').includes('node_modules')) continue
    let text: string
    try {
      // oxlint-disable-next-line no-await-in-loop
      text = await Bun.file(join(dir, path)).text()
    } catch {
      continue
    }
    for (const found of detector.find(text))
      rules.push({ tool: detector.tool, dir: slash < 0 ? '' : path.slice(0, slash), ...found })
  }
  return rules
}

/**
 * The tool whose rule covers names of `scope` in `path` written in `language`, if any. With
 * `kind`, only rules that decide that kind count.
 */
export function enforcedBy(
  rules: readonly ExplicitRule[],
  path: string,
  language: string,
  scope: RuleScope,
  kind?: string,
): string | undefined {
  return rules.find(
    (rule) =>
      rule.scope === scope &&
      (!rule.languages || rule.languages.includes(language)) &&
      (!kind || !rule.kinds || rule.kinds.includes(kind)) &&
      (rule.dir === '' || path.startsWith(`${rule.dir}/`)),
  )?.tool
}
