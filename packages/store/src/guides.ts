import type {
  Family,
  FamilyStore,
  GuideFilter,
  GuideRevision,
  GuideSection,
  GuideSectionInput,
  GuideStore,
} from './types.ts'

const clone = <T>(value: T): T => structuredClone(value)

/** Thrown by `FamilyStore.put` when a member already belongs to another family. */
export class FamilyConflictError extends Error {
  readonly repo: string
  readonly family: string

  constructor(repo: string, family: string) {
    super(`${repo} already belongs to family ${family}`)
    this.name = 'FamilyConflictError'
    this.repo = repo
    this.family = family
  }
}

/** The first member of `family` that another of `families` already holds; throws it as a conflict. */
export function assertNoFamilyConflict(family: Family, families: readonly Family[]): void {
  for (const other of families) {
    if (other.id === family.id) continue
    const taken = family.members.find((member) => other.members.includes(member))
    if (taken) throw new FamilyConflictError(taken, other.name)
  }
}

/**
 * The row `GuideStore.put` stores for `input` over `previous`: the human layer bumps `version`
 * only when `rules` or `steering` changed; otherwise the stored version and byline stay.
 * `revision` is the previous human layer to keep in the history, when there is one.
 */
export function nextGuideSection(
  input: GuideSectionInput,
  previous: GuideSection | undefined,
): { stored: GuideSection; revision?: GuideRevision } {
  const changed =
    (previous?.rules ?? '') !== input.rules || (previous?.steering ?? '') !== input.steering
  const base = {
    scope: input.scope,
    section: input.section,
    rules: input.rules,
    steering: input.steering,
    ...(input.generated && { generated: input.generated }),
    ...(input.proposal && { proposal: input.proposal }),
    learnings: input.learnings,
  }
  if (!changed) {
    return {
      stored: {
        ...base,
        version: previous?.version ?? 0,
        ...(previous?.editedBy !== undefined && { editedBy: previous.editedBy }),
        ...(previous?.editedAt !== undefined && { editedAt: previous.editedAt }),
      },
    }
  }
  const revision: GuideRevision | undefined =
    previous && previous.version > 0
      ? {
          rules: previous.rules,
          steering: previous.steering,
          version: previous.version,
          editedBy: previous.editedBy ?? '',
          editedAt: previous.editedAt ?? '',
        }
      : undefined
  return {
    stored: {
      ...base,
      version: (previous?.version ?? 0) + 1,
      ...(input.editedBy !== undefined && { editedBy: input.editedBy }),
      ...(input.editedAt !== undefined && { editedAt: input.editedAt }),
    },
    ...(revision && { revision }),
  }
}

const key = (scope: string, section: string) => `${scope}\u0000${section}`

/** Whether `section` passes every field of `filter`. */
export const matchesGuideFilter = (section: GuideSection, filter: GuideFilter = {}) =>
  (!filter.scopes || filter.scopes.includes(section.scope)) &&
  (!filter.sections || filter.sections.includes(section.section))

const binary = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const byScopeAndSection = (a: GuideSection, b: GuideSection) =>
  binary(a.scope, b.scope) || binary(a.section, b.section)

/** The in-memory `GuideStore`. */
export function memoryGuides(): GuideStore {
  const rows = new Map<string, GuideSection>()
  const histories = new Map<string, GuideRevision[]>()
  return {
    get: async (scope, section) => clone(rows.get(key(scope, section))),
    list: async (filter) =>
      [...rows.values()]
        .filter((row) => matchesGuideFilter(row, filter))
        .toSorted(byScopeAndSection)
        .map(clone),
    async put(input) {
      const id = key(input.scope, input.section)
      const { stored, revision } = nextGuideSection(clone(input), rows.get(id))
      if (revision) histories.set(id, [revision, ...(histories.get(id) ?? [])])
      rows.set(id, stored)
      return clone(stored)
    },
    history: async (scope, section) => clone(histories.get(key(scope, section)) ?? []),
    async removeScope(scope) {
      for (const [id, row] of rows)
        if (row.scope === scope) {
          rows.delete(id)
          histories.delete(id)
        }
    },
  }
}

/** The in-memory `FamilyStore`. */
export function memoryFamilies(): FamilyStore {
  const families = new Map<string, Family>()
  return {
    list: async () =>
      [...families.values()]
        .toSorted((a, b) => binary(a.name, b.name) || binary(a.id, b.id))
        .map(clone),
    get: async (id) => clone(families.get(id)),
    async put(family) {
      assertNoFamilyConflict(family, [...families.values()])
      families.set(family.id, { ...clone(family), members: family.members.toSorted() })
    },
    async remove(id) {
      families.delete(id)
    },
  }
}
