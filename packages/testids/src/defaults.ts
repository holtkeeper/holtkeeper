/**
 * Test attributes and props of common setups: Testing Library, Cypress, QA teams, React Native.
 * Each also covers names extending it with `-`: `data-test` covers `data-test-id`, `data-test-state`.
 */
export const defaultAttributes: readonly string[] = [
  'data-testid',
  'data-test',
  'data-qa',
  'data-cy',
  'testID',
  'testId',
]

/** Native tags users act on. */
export const defaultTags: readonly string[] = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
]

/** Events whose handlers turn any element or component into something a test clicks or types into. */
export const defaultEvents: readonly string[] = [
  'click',
  'dblclick',
  'doubleclick',
  'press',
  'longpress',
  'tap',
  'change',
  'input',
  'submit',
  'select',
  'toggle',
  'keydown',
  'keyup',
  'mousedown',
  'pointerdown',
]

/** ARIA roles of widgets. */
export const defaultRoles: readonly string[] = [
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'textbox',
  'searchbox',
  'combobox',
  'slider',
  'spinbutton',
  'treeitem',
]

/** Link targets and two-way bindings that make a component interactive. */
export const defaultMarkers: readonly string[] = [
  'href',
  'to',
  'routerLink',
  '[routerLink]',
  'v-model',
  '[(ngModel)]',
  'bind:value',
  'bind:checked',
  'bind:group',
]

/** Factories of styled components: linaria, styled-components, emotion, MUI, chakra, tailwind, framer-motion. */
export const defaultFactories: readonly string[] = ['styled', 'tw', 'chakra', 'motion']
