import { defineAnalysis, metric } from '@holtkeeper/report'
import type { Metric } from '@holtkeeper/report'

import { learnTestIdOptions, renderTestIdConvention, testIdConvention } from './learn.ts'
import {
  type TestIdComponent,
  type TestIdsData,
  attributeUsage,
  testIdsDataSchema,
} from './model.ts'

const elementCount = (components: readonly TestIdComponent[]) =>
  components.reduce((sum, component) => sum + component.total, 0)

/** Analyses stored before the catalog have no `components`; they read as empty. */
const catalogOf = (data: TestIdsData): TestIdsData =>
  Array.isArray(data.components) ? data : { attributes: data.attributes ?? [], components: [] }

function metrics(data: TestIdsData): Metric[] {
  const used = attributeUsage(data.components)
  return [
    metric('components', 'Components', data.components.length, {
      hint: 'Template files with at least one test attribute',
    }),
    metric('elements', 'Elements with test attributes', elementCount(data.components)),
    metric('attributes', 'Attributes in use', used.length, {
      hint: used
        .slice(0, 4)
        .map((attribute) => attribute.name)
        .join(', '),
    }),
  ]
}

/**
 * The `testids` analysis kind: the catalog of test attributes per component. People read the
 * conventions learned from it in the Guide's Test ids section; agents read the catalog through
 * the `test_ids` tool. The report shows the headline numbers and the learned convention only.
 */
export const testIdsAnalysis = defineAnalysis<TestIdsData>({
  kind: 'testids',
  label: 'Test ids',
  schema: testIdsDataSchema,
  summarize: (data) => metrics(catalogOf(data)),
  toReport(current) {
    const data = catalogOf(current.data)
    const convention = testIdConvention(learnTestIdOptions(data))
    return {
      kind: 'testids',
      title: 'Test ids',
      ...(current.ref ? { subtitle: current.ref } : {}),
      generatedAt: current.createdAt,
      metrics: metrics(data),
      sections: [
        {
          id: 'convention',
          title: 'Convention',
          blocks: [
            {
              type: 'markdown',
              text: convention
                ? renderTestIdConvention(convention)
                : 'No test attributes were found in templates.',
            },
          ],
        },
      ],
      subject: { repo: current.repo, ...(current.ref ? { ref: current.ref } : {}) },
    }
  },
})
