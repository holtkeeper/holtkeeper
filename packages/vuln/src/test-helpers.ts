import type { Finding } from './types.ts'

export const finding = (overrides: Partial<Finding> & { id: string }): Finding => ({
  aliases: [],
  summary: '',
  severity: 'high',
  url: `https://osv.dev/${overrides.id}`,
  package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
  source: 'package-lock.json',
  fixedVersions: ['4.17.21'],
  ...overrides,
})
