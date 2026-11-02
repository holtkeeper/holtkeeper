import type { DigestInput } from './model.ts'

/** A ready-made digest people start from; `input` misses only the scope and targets. */
export interface DigestPreset {
  id: string
  label: string
  description: string
  input: Omit<DigestInput, 'scope' | 'targets'>
}

/** Digests most teams want, by the analyses they read. */
export const digestPresets: readonly DigestPreset[] = [
  {
    id: 'weekly-compliance',
    label: 'Weekly compliance',
    description: 'License problems and vulnerable dependencies, every Monday morning.',
    input: {
      name: 'Weekly compliance',
      schedule: { every: 'week', days: ['mon'], time: '10:00' },
      sections: [
        { source: 'licenses', minTone: 'warning' },
        { source: 'audit', minTone: 'warning' },
      ],
      onlyNew: false,
      skipEmpty: true,
    },
  },
  {
    id: 'frontend-hygiene',
    label: 'Frontend hygiene',
    description: 'Images to optimize, bundles that grew and code quality findings.',
    input: {
      name: 'Frontend hygiene',
      schedule: { every: 'week', days: ['wed'], time: '11:00' },
      sections: [
        { source: 'assets', minTone: 'info' },
        { source: 'bundle', minTone: 'warning' },
        { source: 'quality', minTone: 'warning' },
      ],
      onlyNew: true,
      skipEmpty: true,
    },
  },
  {
    id: 'delivery-health',
    label: 'Delivery health',
    description:
      'Stale merge requests, flaky and failing CI jobs, old branches before the weekend.',
    input: {
      name: 'Delivery health',
      schedule: { every: 'week', days: ['fri'], time: '15:00' },
      sections: [
        { source: 'delivery', minTone: 'warning' },
        { source: 'ci-jobs', minTone: 'warning' },
        { source: 'branches', minTone: 'warning' },
      ],
      onlyNew: false,
      skipEmpty: true,
    },
  },
  {
    id: 'release-watch',
    label: 'Release watch',
    description: 'Risky changes waiting for release, every working morning.',
    input: {
      name: 'Release watch',
      schedule: { every: 'day', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '09:30' },
      sections: [{ source: 'release-risk', minTone: 'warning' }],
      onlyNew: true,
      skipEmpty: true,
    },
  },
]
