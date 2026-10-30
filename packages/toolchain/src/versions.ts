/** Newest Node.js major considered when a range has no upper bound. */
export const latestNodeMajor = 26

/** Python 3 minors considered when resolving `requires-python`. */
const knownPythonMinors = [8, 9, 10, 11, 12, 13, 14] as const

const nodeCodenames: Record<string, string> = {
  argon: '4',
  boron: '6',
  carbon: '8',
  dubnium: '10',
  erbium: '12',
  fermium: '14',
  gallium: '16',
  hydrogen: '18',
  iron: '20',
  jod: '22',
  krypton: '24',
}

const sdkmanVendors: Record<string, string> = {
  tem: 'temurin',
  zulu: 'zulu',
  amzn: 'corretto',
  librca: 'liberica',
  graalce: 'graalvm-community',
  graal: 'oracle-graalvm',
  open: 'openjdk',
  sapmchn: 'sapmachine',
  ms: 'microsoft',
  sem: 'semeru',
  oracle: 'oracle',
  mandrel: 'mandrel',
  dragonwell: 'dragonwell',
  kona: 'kona',
}

const exactish = /^\d+(\.\d+){0,2}$/
const rangeish = /^[\sv\d.xX*^~<>=|-]+$/

/** True for strings Bun's semver parser can evaluate as a range; it accepts garbage otherwise. */
const isRange = (range: string) => rangeish.test(range) && /\d|\*|x/i.test(range)

export const satisfies = (version: string, range: string) =>
  isRange(range) && Bun.semver.satisfies(version, range)

const minorsSatisfy = (major: number, range: string) => {
  for (let minor = 0; minor <= 40; minor++) {
    if (satisfies(`${major}.${minor}.0`, range) || satisfies(`${major}.${minor}.99`, range))
      return true
  }
  return false
}

/**
 * The newest Node.js major that has a release inside an npm range, preferring even (LTS) majors;
 * `undefined` when the range is invalid or matches no known major.
 */
export function nodeMajorFor(range: string): string | undefined {
  if (!isRange(range)) return undefined
  const majors = Array.from({ length: latestNodeMajor + 1 }, (_, i) => latestNodeMajor - i)
  const even = majors.find((major) => major % 2 === 0 && major >= 4 && minorsSatisfy(major, range))
  if (even !== undefined) return String(even)
  const any = majors.find((major) => minorsSatisfy(major, range))
  return any === undefined ? undefined : String(any)
}

/**
 * A `.nvmrc` / `.node-version` / volta value as a mise version: `v20` → `20`, `lts/*` → `lts`,
 * `lts/iron` → `20`, `node` → `latest`, ranges → their newest major. `undefined` when unusable.
 */
export function nodeVersion(raw: string): string | undefined {
  const value = raw.trim()
  if (!value) return undefined
  const lower = value.toLowerCase()
  if (['node', 'stable', 'current', 'latest'].includes(lower)) return 'latest'
  if (lower.startsWith('lts/')) return nodeCodenames[lower.slice(4)] ?? 'lts'
  if (lower === 'lts') return 'lts'
  const stripped = value.replace(/^v(?=\d)/, '')
  if (exactish.test(stripped)) return stripped
  return nodeMajorFor(value)
}

/** A PEP 440 / Poetry specifier as an npm range, dropping `!=` clauses Bun cannot evaluate. */
export function pythonRange(specifier: string): string {
  const alternatives = specifier.split('||').map((alternative) =>
    alternative
      .split(',')
      .map((clause) => clause.trim())
      .filter((clause) => clause && !clause.startsWith('!='))
      .map((clause) => {
        const compatible = /^~=\s*(\d+)\.(\d+)(?:\.(\d+))?$/.exec(clause)
        if (compatible) {
          const [, major, minor, patch] = compatible
          return patch === undefined
            ? `>=${major}.${minor} <${Number(major) + 1}`
            : `>=${major}.${minor}.${patch} <${major}.${Number(minor) + 1}`
        }
        const wildcard = /^==\s*([\d.]+)\.\*$/.exec(clause)
        if (wildcard) return `${wildcard[1]}.x`
        return clause.replace(/^===?\s*/, '=').replace(/\s+/g, '')
      })
      .join(' '),
  )
  return alternatives.join(' || ')
}

/** The newest known Python 3 minor (`3.12`) a specifier allows; `undefined` when none does. */
export function pythonMinorFor(specifier: string): string | undefined {
  const range = pythonRange(specifier)
  if (!isRange(range)) return undefined
  const minor = knownPythonMinors
    .toReversed()
    .find((m) => satisfies(`3.${m}.0`, range) || satisfies(`3.${m}.99`, range))
  return minor === undefined ? undefined : `3.${minor}`
}

/** An SDKMAN Java identifier (`21.0.2-tem`) as a mise java version (`temurin-21.0.2`). */
export function sdkmanJava(identifier: string): string {
  const match = /^(.+)-([a-z]+)$/.exec(identifier.trim())
  if (!match) return identifier.trim()
  const [, version = '', vendor = ''] = match
  const mise = sdkmanVendors[vendor]
  return mise ? `${mise}-${version}` : version
}
