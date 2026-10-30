import type { Block } from '@holtkeeper/api'
import { motion } from 'motion/react'

import { stagger } from '../../../ui/index.ts'
import { MetricCard } from '../MetricCard.tsx'

/** A row of metric cards inside a section. */
export function MetricsBlock({ block }: { block: Extract<Block, { type: 'metrics' }> }) {
  return (
    <motion.div {...stagger} className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
      {block.metrics.map((metric) => (
        <MetricCard key={metric.id} metric={metric} />
      ))}
    </motion.div>
  )
}
