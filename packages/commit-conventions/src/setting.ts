import { z } from 'zod'

import { compilePattern } from './title.ts'

/** Setting key of the commit and branch conventions of a repository. */
export const commitConventionsKey = 'commits.conventions'

const pattern = z
  .string()
  .min(1)
  .refine((value) => compilePattern(value) !== undefined, 'not a valid regular expression')

const ticket = z.object({
  pattern: pattern.describe('One key, e.g. GTW-\\d+'),
  required: z.boolean().default(true),
  placement: z
    .enum(['bracket', 'prefix', 'scope', 'suffix', 'anywhere'])
    .optional()
    .describe('Commit titles: [GTW-1] subject, GTW-1 subject, type(GTW-1), subject (GTW-1)'),
})

const word = z.string().trim().min(1)

/** Value of the `commits.conventions` setting. */
export const commitConventionsSchema = z.object({
  commit: z
    .object({
      pattern: pattern.optional().describe('The whole message must match'),
      forbidden: pattern.optional().describe('No message may match'),
      template: z.string().trim().min(1).optional().describe('e.g. <type>(<scope>): <subject>'),
      conventional: z.boolean().optional(),
      types: z.array(word).optional(),
      scopes: z.array(word).optional(),
      scopeRequired: z.boolean().optional(),
      ticket: ticket.optional(),
      maxLength: z.number().int().min(20).max(500).optional(),
      subjectCase: z.enum(['lower', 'upper']).optional(),
      noTrailingPeriod: z.boolean().optional(),
      body: z.enum(['none', 'optional', 'required']).optional(),
      examples: z.array(word).optional(),
    })
    .optional(),
  branch: z
    .object({
      pattern: pattern.optional().describe('Names of new branches must match'),
      template: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('e.g. <prefix>/<TICKET>-<description>'),
      prefixes: z.array(word).optional(),
      ticket: ticket.omit({ placement: true }).optional(),
      case: z.enum(['kebab', 'snake']).optional(),
      examples: z.array(word).optional(),
    })
    .optional(),
  notes: z.string().optional().describe('Anything else agents and people should know, in Markdown'),
  history: z
    .boolean()
    .default(true)
    .describe('Also learn rules from recent commits and branches; set rules win over learned ones'),
})

/** Parsed `commits.conventions` value. */
export type CommitConventionsSetting = z.infer<typeof commitConventionsSchema>

const help = `How commit messages and branch names of a repository should look. Agents read the result through the MCP tools \`commit_conventions\` and \`check_commit_message\`.

- Rules come from four places, strongest first: this setting, the forge's **push rules** (GitLab Premium), the repository's **commitlint** config, and the **recent history** of the default branch and its branches.
- Fields set here replace the same field from the other sources; patterns from push rules always apply on top.
- History only proposes a rule when at least 80% of recent commits or branches follow it, and \`check_commit_message\` reports breaks of such rules as warnings, not errors.
- Turn \`history\` off when old commits do not follow the rules you want now.
- The most specific scope wins as a whole: a repository entry replaces its group's.`

/** The `commits.conventions` setting for the settings registry. */
export const commitConventionsSetting = {
  key: commitConventionsKey,
  label: 'Commit conventions',
  description:
    'Rules for commit messages and branch names that agents follow, on top of what history shows.',
  section: 'Repositories',
  schema: commitConventionsSchema,
  help,
  presets: [
    {
      id: 'conventional',
      label: 'Conventional Commits',
      description: 'type(scope): subject, lowercase, without a trailing period.',
      value: {
        commit: {
          conventional: true,
          types: [
            'feat',
            'fix',
            'docs',
            'refactor',
            'perf',
            'test',
            'build',
            'ci',
            'chore',
            'revert',
          ],
          subjectCase: 'lower',
          noTrailingPeriod: true,
          maxLength: 100,
        },
      },
    },
    {
      id: 'ticket',
      label: 'Ticket in every title',
      description: 'type(scope): [KEY-123] subject; set the pattern to your tracker keys.',
      value: {
        commit: {
          conventional: true,
          ticket: { pattern: '[A-Z][A-Z0-9]+-\\d+', required: true, placement: 'bracket' },
        },
        branch: { ticket: { pattern: '[A-Z][A-Z0-9]+-\\d+', required: true } },
      },
    },
  ],
}
