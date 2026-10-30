import type { QualityCategory } from '@holtkeeper/quality'

const complexityWords = new Set([
  'cyclomatic',
  'cognitive',
  'gocyclo',
  'gocognit',
  'cyclop',
  'funlen',
  'nestif',
  'maintidx',
  'max-depth',
  'max-lines',
  'max-lines-per-function',
  'max-params',
  'max-statements',
  'max-nested-callbacks',
])

const styleWords = new Set([
  'style',
  'stylistic',
  'format',
  'formatting',
  'layout',
  'naming',
  'whitespace',
  'gofmt',
  'gofumpt',
  'goimports',
  'stylecheck',
])

const securityWords = new Set([
  'security',
  'owasp',
  'gosec',
  'bandit',
  'vulnerability',
  'injection',
  'xss',
])

/**
 * Guesses the category of a rule from its id and any descriptive words a tool attaches (tags,
 * plugin category, ESLint `meta.type`). Security wins over complexity, complexity over style;
 * everything else, including correctness, is `lint`.
 */
export function categorize(ruleId: string, hints: readonly unknown[] = []): QualityCategory {
  const words = [ruleId, ...hints.filter((hint): hint is string => typeof hint === 'string')]
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(Boolean)
  if (
    words.some(
      (word) => securityWords.has(word) || /^cwe-?\d+$/.test(word) || /^s\d{3}$/.test(word),
    )
  )
    return 'security'
  if (
    words.some(
      (word) => word.includes('complexity') || complexityWords.has(word) || /^c90\d$/.test(word),
    )
  )
    return 'complexity'
  if (words.some((word) => styleWords.has(word))) return 'style'
  return 'lint'
}
