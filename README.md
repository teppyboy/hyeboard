# Hyeboard

Modern multi-university student dashboard. UET first, with StudentHub + Canvas adapter support.

## Apps

- `apps/web`: React, Vite, TanStack Router, TanStack Query, shadcn-style UI components, Tailwind CSS.
- `apps/api`: Elysia Cloudflare Worker BFF/proxy.

## Packages

- `packages/schemas`: shared TypeScript models.
- `packages/core`: Worker-safe helpers, API envelopes, encrypted bearer session helpers.
- `packages/university-adapters`: mock adapter and UET adapter boundary.

## Security

Raw HAR files are ignored by git. They can contain cookies, tokens, session IDs, SAML payloads, student IDs, and PII. Do not commit them.

## Development

```bash
pnpm install
pnpm dev
```

API local env lives in `apps/api/.dev.vars`:

```txt
HYEB_SESSION_SECRET=replace-with-at-least-32-random-bytes
HYEB_ALLOWED_ORIGINS=http://localhost:5173
```

Web local env lives in `apps/web/.env.local`:

```txt
VITE_API_BASE_URL=http://localhost:8787
```

## Auth Status

Hyeboard uses an encrypted Bearer token issued by the Worker. StudentHub and Canvas upstream auth are represented as upstream credentials inside the encrypted payload. Canvas official API access should use OAuth Bearer tokens where available; StudentHub auth transport still needs live probing because HAR exports strip auth headers/cookies.
