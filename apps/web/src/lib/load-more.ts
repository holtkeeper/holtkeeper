/**
 * Whether a `LoadMore` button should press itself on an intersection change: only when it comes
 * into view (it was out of view before) and no page is loading. A button that stays visible after
 * a page arrives waits for the next time it scrolls into view or for a click, so a list whose
 * footer is always on screen never loads page after page by itself.
 */
export const shouldAutoLoad = (wasVisible: boolean, visible: boolean, pending: boolean): boolean =>
  visible && !wasVisible && !pending
