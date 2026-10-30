/** Name shown for a passkey: its label, else its position. */
export const passkeyName = (passkey: { label?: string }, index: number): string =>
  passkey.label?.trim() || `Passkey ${index + 1}`

/** Whether a WebAuthn error means the person closed or declined the browser prompt. */
export const isCancelled = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError')
