---
name: no-hardcoded-credentials
severity: high
applies_to: '**/*.{ts,tsx,js,jsx,go,rs,py,yaml,yml,json,toml,env}'
---

# No Hardcoded Credentials

## What

API keys, tokens, passwords, connection strings, certificates, or other secrets committed in source.

## Why

Once committed, secrets are forever in git history — even if you `git rm` them. Anyone with repo access can extract them. Many leaks have been found years later by scanning public mirrors.

## Pattern

### Heuristic

Match strings that:

1. Have a known prefix indicating a credential type:
   - `sk-` (OpenAI / Stripe)
   - `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` (GitHub tokens)
   - `AKIA` (AWS access key)
   - `xoxb-`, `xoxp-`, `xoxa-` (Slack)
   - `Bearer ` followed by entropy > 4.5
2. Match `-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----` (private keys)
3. Match `(password|api_?key|secret|token)\s*[:=]\s*["']\w{16,}["']` (credential-like assignment)

## Example violation

```typescript
const STRIPE_KEY = 'sk_live_<REDACTED_EXAMPLE_PLACEHOLDER>'; // illustrative only
```

```yaml
database:
  url: "postgres://admin:hunter2@db.example.com/prod"
```

## Example fix

Move to environment variables (or a secret manager):

```typescript
const STRIPE_KEY = process.env.STRIPE_KEY;
if (!STRIPE_KEY) {
  throw new Error('STRIPE_KEY is required');
}
```

```yaml
database:
  url: ${DATABASE_URL}  # injected at deploy time
```

**Critical**: if a real secret was committed, **rotate it** in addition to removing it. Removing from source does not remove it from history.

## Exceptions

- Values matching a placeholder pattern (`xxxxxxxx`, `your-key-here`, `${...}`)
- Test fixtures explicitly marked as fake (e.g. `sk-test-FAKE_FAKE_FAKE`)
- Files under `**/test/**`, `**/fixtures/**`, `**/__mocks__/**`

## Notes for the scanner

- This rule fires at `high` severity. P1 ticket. Escalate to the human reviewer immediately.
- Never include the actual secret value in findings, comments, or commits — just say "credential matching pattern X at line Y".
