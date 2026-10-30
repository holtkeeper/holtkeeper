# @holtkeeper/vault

Encryption for secrets at rest: forge tokens, API keys, secret settings.

```ts
interface Vault {
  seal(plaintext: string): Promise<string>
  open(sealed: string): Promise<string>
}
```

`aesVault(secret)` uses AES-256-GCM with a key derived from `secret` (SHA-256) and a random IV per value. Sealed values look like `v1.<iv>.<ciphertext>`; the version prefix leaves room for key rotation or new algorithms. Use at least 32 random characters, e.g. `openssl rand -base64 48`, from an environment variable.

Losing the key makes every sealed value unreadable. A KMS-backed vault only needs to implement the two methods.
