/** `1 message`, `3 messages`; `many` for irregular plurals. */
export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`
