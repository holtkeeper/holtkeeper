const attackVector: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }
const attackComplexity: Record<string, number> = { L: 0.77, H: 0.44 }
const userInteraction: Record<string, number> = { N: 0.85, R: 0.62 }
const impact: Record<string, number> = { H: 0.56, L: 0.22, N: 0 }
const privileges: Record<string, { unchanged: number; changed: number }> = {
  N: { unchanged: 0.85, changed: 0.85 },
  L: { unchanged: 0.62, changed: 0.68 },
  H: { unchanged: 0.27, changed: 0.5 },
}

/** CVSS 3.1 `Roundup`: the smallest one-decimal number not below `value`, free of float noise. */
function roundUp(value: number): number {
  const scaled = Math.round(value * 100_000)
  return scaled % 10_000 === 0 ? scaled / 100_000 : (Math.floor(scaled / 10_000) + 1) / 10
}

/**
 * The base score of a CVSS 3.0 or 3.1 vector (`CVSS:3.1/AV:N/AC:L/...`), or `undefined` for
 * other versions and vectors missing a base metric.
 */
export function cvss3BaseScore(vector: string): number | undefined {
  const [version, ...parts] = vector.trim().split('/')
  if (version !== 'CVSS:3.0' && version !== 'CVSS:3.1') return undefined
  const metrics = new Map<string, string>()
  for (const part of parts) {
    const [name, value] = part.split(':')
    if (name && value) metrics.set(name, value)
  }
  const scope = metrics.get('S')
  const av = attackVector[metrics.get('AV') ?? '']
  const ac = attackComplexity[metrics.get('AC') ?? '']
  const pr = privileges[metrics.get('PR') ?? '']
  const ui = userInteraction[metrics.get('UI') ?? '']
  const c = impact[metrics.get('C') ?? '']
  const i = impact[metrics.get('I') ?? '']
  const a = impact[metrics.get('A') ?? '']
  if (
    (scope !== 'U' && scope !== 'C') ||
    av === undefined ||
    ac === undefined ||
    pr === undefined ||
    ui === undefined ||
    c === undefined ||
    i === undefined ||
    a === undefined
  )
    return undefined

  const changed = scope === 'C'
  const iss = 1 - (1 - c) * (1 - i) * (1 - a)
  const impactScore = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss
  if (impactScore <= 0) return 0
  const exploitability = 8.22 * av * ac * (changed ? pr.changed : pr.unchanged) * ui
  return roundUp(Math.min((changed ? 1.08 : 1) * (impactScore + exploitability), 10))
}
