/** A literal value or a reference to an environment variable, resolved when used. */
export type Secret = string | { env: string }

/** References an environment variable without reading it yet. */
export const env = (name: string): Secret => ({ env: name })

/** Returns the secret's value; throws when the referenced variable is unset or empty. */
export function resolveSecret(secret: Secret): string {
  if (typeof secret === 'string') return secret
  const value = process.env[secret.env]
  if (!value) throw new Error(`environment variable ${secret.env} is not set`)
  return value
}
