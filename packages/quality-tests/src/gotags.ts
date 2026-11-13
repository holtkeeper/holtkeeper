const PLATFORM_TAGS = new Set([
  'aix',
  'android',
  'darwin',
  'dragonfly',
  'freebsd',
  'hurd',
  'illumos',
  'ios',
  'js',
  'linux',
  'nacl',
  'netbsd',
  'openbsd',
  'plan9',
  'solaris',
  'wasip1',
  'windows',
  'zos',
  '386',
  'amd64',
  'amd64p32',
  'arm',
  'armbe',
  'arm64',
  'arm64be',
  'loong64',
  'mips',
  'mipsle',
  'mips64',
  'mips64le',
  'mips64p32',
  'mips64p32le',
  'ppc',
  'ppc64',
  'ppc64le',
  'riscv',
  'riscv64',
  's390',
  's390x',
  'sparc',
  'sparc64',
  'wasm',
  'unix',
  'cgo',
  'gc',
  'gccgo',
])

const DEFAULT_TAGS = new Set(['linux', 'amd64', 'unix', 'cgo', 'gc'])

const isPlatformTag = (tag: string) => PLATFORM_TAGS.has(tag) || /^go1\.\d+$/.test(tag)

/** The expression of a file's `//go:build` line; only lines above the `package` clause count. */
export function goBuildConstraint(source: string): string | undefined {
  let inBlock = false
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (inBlock) {
      if (line.includes('*/')) inBlock = false
      continue
    }
    if (line.startsWith('//go:build ')) return line.slice('//go:build '.length).trim()
    if (!line || line.startsWith('//')) continue
    if (line.startsWith('/*')) {
      inBlock = !line.includes('*/')
      continue
    }
    return undefined
  }
  return undefined
}

/** Evaluates a `//go:build` expression with the given tags set; `undefined` when it is malformed. */
export function evalGoBuildConstraint(
  expression: string,
  isSet: (tag: string) => boolean,
): boolean | undefined {
  const tokens = expression.match(/&&|\|\||[!()]|[\w.]+/g) ?? []
  let at = 0
  const or = (): boolean | undefined => {
    let value = and()
    while (tokens[at] === '||') {
      at++
      const right = and()
      if (value === undefined || right === undefined) return undefined
      value = value || right
    }
    return value
  }
  const and = (): boolean | undefined => {
    let value = not()
    while (tokens[at] === '&&') {
      at++
      const right = not()
      if (value === undefined || right === undefined) return undefined
      value = value && right
    }
    return value
  }
  const not = (): boolean | undefined => {
    const token = tokens[at++]
    if (token === '!') {
      const value = not()
      return value === undefined ? undefined : !value
    }
    if (token === '(') {
      const value = or()
      return tokens[at++] === ')' ? value : undefined
    }
    return token && /^[\w.]+$/.test(token) ? isSet(token) : undefined
  }
  const value = or()
  return at === tokens.length ? value : undefined
}

/** Test files a Go run leaves out because they need build tags it does not set. */
export interface GoTaggedTests {
  /** Number of such test files. */
  files: number
  /** Tag name to the number of those files that mention it, most used first. */
  tags: { tag: string; files: number }[]
}

/**
 * Finds `_test.go` files whose `//go:build` line excludes them from a linux/amd64 run with `tags`
 * set but would include them once their own non-platform tags are set too. Files excluded only by
 * platform (`windows`, `!cgo`) or Go version are not counted.
 */
export function goTaggedTests(
  files: readonly { file: string; source: string }[],
  tags: readonly string[] = [],
): GoTaggedTests {
  const set = new Set([...DEFAULT_TAGS, ...tags])
  const isSet = (tag: string) => set.has(tag) || /^go1\.\d+$/.test(tag)
  const counts = new Map<string, number>()
  let skipped = 0
  for (const { file, source } of files) {
    if (!file.endsWith('_test.go')) continue
    const expression = goBuildConstraint(source)
    if (!expression || evalGoBuildConstraint(expression, isSet) !== false) continue
    const custom = [...new Set(expression.match(/[\w.]+/g) ?? [])].filter(
      (tag) => !isPlatformTag(tag) && !set.has(tag),
    )
    if (!custom.length) continue
    const withCustom = (tag: string) => isSet(tag) || custom.includes(tag)
    if (evalGoBuildConstraint(expression, withCustom) !== true) continue
    skipped++
    for (const tag of custom) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return {
    files: skipped,
    tags: [...counts]
      .map(([tag, count]) => ({ tag, files: count }))
      .toSorted((a, b) => b.files - a.files || a.tag.localeCompare(b.tag)),
  }
}
