import type {
  ReviewAnalytics,
  ReviewAnalyticsPhase,
  ReviewCostDay,
  ReviewSizeClass,
  ReviewTrendDay,
} from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'

/** Every phase in the order the page stacks and lists them. */
export const analyticsPhases: readonly ReviewAnalyticsPhase[] = [
  'initial',
  'update',
  'recheck',
  'reply',
  'other',
]

/** How each phase is named and colored on Ops › Review analytics. */
export const phaseInfo: Record<
  ReviewAnalyticsPhase,
  { label: string; tone: StatusTone; description: string }
> = {
  initial: {
    label: 'First review',
    tone: 'accent',
    description: 'The first review of a merge request',
  },
  update: {
    label: 'New commits',
    tone: 'info',
    description: 'Reviews of commits pushed after a review',
  },
  recheck: {
    label: 'Rechecks',
    tone: 'code',
    description: 'Checking earlier threads against new commits',
  },
  reply: {
    label: 'Replies',
    tone: 'success',
    description: 'Answers in threads after a person replied',
  },
  other: { label: 'Other', tone: 'default', description: 'Review runs recorded without a phase' },
}

/** Sum of a day's spend over every phase. */
export const dayTotal = (day: ReviewCostDay) =>
  analyticsPhases.reduce((sum, phase) => sum + (day.phases[phase] ?? 0), 0)

/** Total review spend of the period. */
export const reviewSpend = (analytics: Pick<ReviewAnalytics, 'phases'>) =>
  analytics.phases.reduce((sum, entry) => sum + entry.costUsd, 0)

/** Replies a person drew out of the bot, however it answered. */
export const replyCount = (replies: ReviewAnalytics['runs']['replies']) =>
  replies.explain +
  replies.concede +
  replies.update +
  replies.fixed +
  replies.open +
  replies.unknown

/** `part` over `whole`; `undefined` when `whole` is 0. */
export const share = (part: number, whole: number) => (whole > 0 ? part / whole : undefined)

/** How each size class is named, with the estimated human review time it covers. */
export const sizeInfo: Record<ReviewSizeClass, { label: string; hint: string }> = {
  small: { label: 'Small', hint: 'Under 15 minutes of human review' },
  medium: { label: 'Medium', hint: '15 minutes to an hour' },
  large: { label: 'Large', hint: 'One to three hours' },
  huge: { label: 'Huge', hint: 'Over three hours' },
}

/** Fixed over the comments judged that day; `undefined` when none was judged. */
export const dayAcceptance = (day: ReviewTrendDay) =>
  share(day.fixed, day.fixed + day.resolved + day.ignored)

/**
 * Answers where the bot agreed with the person who replied, over every recorded answer: how
 * often a comment people pushed back on turned out wrong.
 */
export const concedeShare = (replies: ReviewAnalytics['runs']['replies']) =>
  share(replies.concede, replyCount(replies) - replies.unknown)
