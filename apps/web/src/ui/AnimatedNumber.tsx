import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { useEffect } from 'react'

const integer = new Intl.NumberFormat('en')
const defaultFormat = (value: number) => integer.format(Math.round(value))

/**
 * A number that counts smoothly to its new value; jumps instantly with reduced motion. `format`
 * renders intermediate values too, e.g. as bytes.
 */
export function AnimatedNumber({
  value,
  className,
  format = defaultFormat,
}: {
  value: number
  className?: string
  format?: (value: number) => string
}) {
  const reduce = useReducedMotion()
  const current = useMotionValue(0)
  const text = useTransform(current, format)

  useEffect(() => {
    if (reduce) current.set(value)
    const controls = reduce
      ? undefined
      : animate(current, value, { duration: 0.9, ease: [0.16, 1, 0.3, 1] })
    return () => controls?.stop()
  }, [current, reduce, value])

  return (
    <motion.span className={`tabular ${className ?? ''}`} aria-label={format(value)}>
      {text}
    </motion.span>
  )
}
