import type { QualityCheck, QualityIssue } from '@holtkeeper/quality'
import { stableId } from '@holtkeeper/quality'
import { listFiles } from '@holtkeeper/quality-tests'

import { analyzeTestIds, type FindUntaggedOptions, findUntagged } from './analyze.ts'
import { attributeUsage, type TestIdComponent } from './model.ts'
import { builtinSources } from './sources.ts'

export type TestIdsCheckOptions = Omit<FindUntaggedOptions, 'dir' | 'signal'>

/** Tool name of `testIdsCheck` issues; reviews hand these to their agent. */
export const TESTIDS_TOOL = 'testids'

const EXAMPLES = 3

/** The most used attribute that has static values, e.g. `data-test-id` over `data-test-state`. */
const named = (pool: readonly TestIdComponent[]) =>
  attributeUsage(pool).find((attribute) => attribute.values.length)

function conventionOf(components: readonly TestIdComponent[], file: string) {
  const local = components.find((component) => component.file === file)
  const used = attributeUsage(components)
  const own = local ? named([local]) : undefined
  const main = own ?? named(components) ?? used[0]
  if (!main) return undefined
  const examples = main.values.slice(0, EXAMPLES).map((value) => `\`${main.name}="${value}"\``)
  const others = used
    .filter((attribute) => attribute.name !== main.name)
    .slice(0, 3)
    .map((attribute) => `\`${attribute.name}\``)
  return [
    `Tests in this project select elements by \`${main.name}\``,
    examples.length ? `${own ? 'this component already uses' : 'e.g.'} ${examples.join(', ')}` : '',
    others.length ? `other test attributes in use: ${others.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ')
}

/**
 * The `testids` check: interactive elements without a test attribute, reported only when the
 * project already uses test attributes. Each issue's `help` names the project's attribute and
 * example values, so a reviewer can propose one in the same style.
 */
export function testIdsCheck(options: TestIdsCheckOptions = {}): QualityCheck {
  return {
    name: TESTIDS_TOOL,
    async detect(dir) {
      const sources = options.sources ?? Object.values(builtinSources)
      return (await listFiles(dir)).some((file) => sources.some((source) => source.matches(file)))
    },
    async run({ dir, signal }) {
      const catalog = await analyzeTestIds({ ...options, dir, ...(signal ? { signal } : {}) })
      if (!catalog.components.length) return { skipped: 'the project uses no test attributes' }
      const untagged = await findUntagged({ ...options, dir, ...(signal ? { signal } : {}) })
      const issues = untagged
        .filter((element) => element.status === 'missing')
        .map((element): QualityIssue => {
          const help = conventionOf(catalog.components, element.file)
          return {
            id: stableId(TESTIDS_TOOL, 'missing-test-id', element.file, element.tag, element.line),
            tool: TESTIDS_TOOL,
            rule: 'missing-test-id',
            category: 'tests',
            severity: 'warning',
            message: `\`<${element.tag}>\`${element.as ? ` (renders \`<${element.as}>\`)` : ''} is interactive (${element.reason}) but has no test attribute, so end-to-end tests cannot select it reliably.`,
            ...(help ? { help } : {}),
            file: element.file,
            range: {
              start: { line: element.line, column: 1 },
              end: { line: element.line, column: 1 },
            },
          }
        })
      return { issues }
    },
  }
}
