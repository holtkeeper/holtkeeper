import {
  type MessageCatalog,
  type Messages,
  defineCatalog,
  sourceMessages,
} from '@holtkeeper/messages'

/**
 * The fixed texts the review posts on merge requests, in English. Severity labels and categories
 * are printed as they are and are not part of the catalog.
 */
export const reviewMessageCatalog = defineCatalog({
  id: 'review',
  title: 'Code review',
  messages: {
    'progress.running': {
      text: '⏳ **Holtkeeper is reviewing this merge request.** This usually takes a few minutes. Please wait until the review finishes: its comments and a summary will appear here.',
      note: 'Posted when a review starts; removed when it ends.',
    },
    'progress.done': {
      text: '✅ The automatic review has finished; see its summary.',
      note: 'Replaces the progress note when the forge cannot delete it.',
    },
    'progress.failed': {
      text: '⚠️ **The automatic review of this merge request could not finish.** Comment `/holtkeeper review` to try again.',
      note: 'Replaces the progress note when the review fails.',
    },
    'verdict.needsChanges': {
      text: 'Needs changes',
      note: 'Verdict after the summary heading "Holtkeeper review:".',
    },
    'verdict.looksGood': { text: 'Looks good', note: 'Verdict after the summary heading.' },
    'verdict.notReviewed': { text: 'Not reviewed', note: 'Verdict after the summary heading.' },
    'scope.full': { text: 'Reviewed `{head}`', note: '{head} is a short commit hash.' },
    'scope.incremental': {
      text: 'Reviewed the changes from `{from}` to `{to}`',
      note: '{from} and {to} are short commit hashes.',
    },
    'scope.stats': {
      text: '{scope}: {files} file(s), {lines} changed line(s).',
      note: '{scope} is the "Reviewed ..." text.',
    },
    'scope.effort': {
      text: 'Review effort: {effort}/5.',
      note: 'How hard the change is for a person to review, from 1 to 5.',
    },
    'scope.time': {
      text: 'Estimated review time: {time}.',
      note: '{time} is a duration such as "~45 min".',
    },
    'scope.timeWhole': {
      text: 'Estimated review time of the whole merge request: {time}.',
      note: 'Incremental reviews: the estimate still covers the whole merge request, not only the new commits. {time} is a duration such as "~45 min".',
    },
    'duration.minutes': {
      text: '~{minutes} min',
      note: 'Approximate duration under an hour; keep it short.',
    },
    'duration.hours': { text: '~{hours} h', note: 'Approximate duration in whole hours.' },
    'duration.hoursMinutes': {
      text: '~{hours} h {minutes} min',
      note: 'Approximate duration in hours and minutes.',
    },
    'walkthrough.files': { text: 'Files', note: 'Column of the walkthrough table.' },
    'walkthrough.change': { text: 'Change', note: 'Column of the walkthrough table.' },
    'findings.count': {
      text: 'Findings',
      note: 'Column next to "Severity" in the table of findings per severity.',
    },
    'threads.earlier': {
      text: 'Earlier threads: {resolved} resolved, {replied} still relevant.',
      note: 'Review comments from earlier runs.',
    },
    'notReviewed.title': { text: 'Not reviewed', note: 'Collapsed list of what was skipped.' },
    'notReviewed.ignored': { text: 'ignored path', note: 'Why a file was not reviewed.' },
    'notReviewed.binary': { text: 'binary', note: 'Why a file was not reviewed.' },
    'notReviewed.collapsed': {
      text: 'diff too large for the forge',
      note: 'Why a file was not reviewed.',
    },
    'notReviewed.deleted': { text: 'deleted', note: 'Why a file was not reviewed.' },
    'notReviewed.unchanged': {
      text: 'no new lines to review',
      note: 'Why a file was not reviewed.',
    },
    'notReviewed.tooLarge': {
      text: 'merge request over the size limit',
      note: 'Why a file was not reviewed.',
    },
    'notReviewed.belowSeverity': { text: '{count} finding(s) below the severity threshold' },
    'notReviewed.overLimit': { text: '{count} finding(s) over the comment limit' },
    'notReviewed.checkFailed': {
      text: 'check {name} failed: {error}',
      note: '{name} is a check such as "secrets"; {error} stays in English.',
    },
    'notReviewed.rejected': { text: '{count} comment(s) the forge rejected' },
    'summary.tooLarge': {
      text: 'The diff has {lines} changed lines, more than the limit of {limit}; it was not reviewed. Split the merge request or review it with `/holtkeeper review maxDiffLines=<n>`.',
    },
    'summary.nothingNew': { text: 'Nothing new to review.' },
    'summary.feedback': {
      text: '_Holtkeeper learns from your answers. If a comment is wrong or misses the point, reply in its thread and explain how it should be: future reviews take such replies into account. 👍 or 👎 on a comment help too._',
      note: 'Last line of every review summary.',
    },
    'thread.resolved': {
      text: 'Resolved at `{head}`: {note}',
      note: 'Reply that closes a fixed review comment; {note} is written by the model.',
    },
    'thread.stillApplies': {
      text: 'Still applies at `{head}`: {note}',
      note: 'Reply to a review comment that is still relevant; {note} is written by the model.',
    },
  },
})

/** Keys of the review's fixed texts. */
export type ReviewMessageKey =
  typeof reviewMessageCatalog extends MessageCatalog<infer Key> ? Key : never

/** The review's fixed texts in one language. */
export type ReviewMessages = Messages<ReviewMessageKey>

/** The review's fixed texts in English. */
export const englishReviewMessages: ReviewMessages = sourceMessages(reviewMessageCatalog)
