# Admin Dashboard Guide

Hyeboard's admin dashboard controls feature availability and selected operational limits without exposing university credentials or bypassing adapter capabilities. It uses a separate admin session from student accounts.

## Routes

| Route | Purpose |
| --- | --- |
| `/admin/login` | Sign in with a configured password, GitHub account, or Discord account |
| `/admin` | Edit and publish feature policy |
| `/admin/history` | Inspect revisions and roll back to an earlier policy |
| `/admin/auth` | Inspect the current admin identity and sign out |

## Policy rules

- Adapter capabilities are the upper bound. The dashboard cannot enable an unsupported feature.
- A global disabled switch disables that feature for every university.
- A university override can only disable a feature further; it cannot override a global disable.
- An empty global limit means no additional admin cap. Native security and adapter ceilings still apply.
- An empty university limit inherits the global value.
- Every publish requires a reason and creates an immutable audit revision.
- Rollback publishes the selected historical policy as a new revision. It never rewrites history.

## Configure authentication

At least `HYEB_ADMIN_SESSION_SECRET` is required. It must be separate from `HYEB_SESSION_SECRET` and contain at least 32 characters. Rotating it signs out all admins without affecting student sessions.

### Password login

Generate the versioned PBKDF2 hash through the masked prompt:

```bash
pnpm --filter @hyeboard/worker admin:hash-password
```

Store the output as `HYEB_ADMIN_PASSWORD_HASH`. Do not store the plaintext password.

### GitHub or Discord login

Each enabled provider requires all three values:

| Provider | Client ID | Client secret | Allowed numeric user IDs |
| --- | --- | --- | --- |
| GitHub | `HYEB_ADMIN_GITHUB_CLIENT_ID` | `HYEB_ADMIN_GITHUB_CLIENT_SECRET` | `HYEB_ADMIN_GITHUB_IDS` |
| Discord | `HYEB_ADMIN_DISCORD_CLIENT_ID` | `HYEB_ADMIN_DISCORD_CLIENT_SECRET` | `HYEB_ADMIN_DISCORD_IDS` |

Allowlists are comma-separated canonical numeric IDs. Usernames and email addresses do not grant access. Duplicate, zero, leading-zero, or non-numeric IDs are rejected.

Set the exact external origin, without a trailing slash:

```text
HYEB_ADMIN_PUBLIC_ORIGIN=https://hyeboard.example.com
```

Register the enabled provider callbacks:

```text
https://hyeboard.example.com/api/admin/oauth/github/callback
https://hyeboard.example.com/api/admin/oauth/discord/callback
```

`HYEB_ADMIN_SESSION_TTL_SECONDS` defaults to `3600` and must be between `1` and `86400`.

## Kubernetes setup

Distributed mode uses PostgreSQL for policy authority and Redis for propagation. It never falls back to local SQLite. Do not set `HYEB_ADMIN_DB_PATH` in Kubernetes.

### 1. Add secrets

Add these keys to the existing `hyeboard-runtime` Secret through the cluster's secret manager:

```text
HYEB_ADMIN_SESSION_SECRET
HYEB_ADMIN_PASSWORD_HASH                 # optional
HYEB_ADMIN_GITHUB_CLIENT_SECRET          # optional
HYEB_ADMIN_DISCORD_CLIENT_SECRET         # optional
```

`deploy/k8s/base/secret.example.yaml` is a name template only. Never apply it unchanged or commit a rendered Secret. Keep all existing runtime keys when updating `hyeboard-runtime`.

Confirm key presence without printing values:

```bash
kubectl -n <namespace> get secret hyeboard-runtime -o json \
  | jq -e '.data.HYEB_ADMIN_SESSION_SECRET != null'
```

For password login, also check:

```bash
kubectl -n <namespace> get secret hyeboard-runtime -o json \
  | jq -e '.data.HYEB_ADMIN_PASSWORD_HASH != null'
```

### 2. Add non-secret configuration

Add the applicable values to the target overlay's `configMapGenerator` merge. Example:

```yaml
configMapGenerator:
  - name: hyeboard-runtime
    behavior: merge
    literals:
      - HYEB_ADMIN_SESSION_TTL_SECONDS=3600
      - HYEB_ADMIN_PUBLIC_ORIGIN=https://hyeboard.example.com
      - HYEB_ADMIN_GITHUB_CLIENT_ID=replace-with-client-id
      - HYEB_ADMIN_GITHUB_IDS=123456789
      - HYEB_ADMIN_DISCORD_CLIENT_ID=replace-with-client-id
      - HYEB_ADMIN_DISCORD_IDS=123456789012345678
```

Omit unused provider values as a complete group. Password login needs no client ID or allowlist.

### 3. Validate and roll out

```bash
pnpm test:k8s
kubectl kustomize deploy/k8s/overlays/<overlay> >/tmp/hyeboard.yaml
kubectl apply -f /tmp/hyeboard.yaml
kubectl -n <namespace> rollout status deployment/hyeboard-api
```

A Secret update does not automatically change the pod template. Restart the API deployment after an out-of-band Secret update:

```bash
kubectl -n <namespace> rollout restart deployment/hyeboard-api
kubectl -n <namespace> rollout status deployment/hyeboard-api
```

### 4. Verify before use

```bash
curl -fsS https://hyeboard.example.com/api/ready
curl -i https://hyeboard.example.com/api/admin/session
```

The unauthenticated session response should be HTTP `200`, include `authenticated: false`, and list the configured login methods. Then open:

```text
https://hyeboard.example.com/admin/login
```

## Helm setup

Reference an externally managed Secret and place only non-secret values under `config.runtime`:

```yaml
secrets:
  create: false
  existingSecret: hyeboard-runtime

config:
  runtime:
    HYEB_ADMIN_SESSION_TTL_SECONDS: "3600"
    HYEB_ADMIN_PUBLIC_ORIGIN: https://hyeboard.example.com
    HYEB_ADMIN_GITHUB_CLIENT_ID: replace-with-client-id
    HYEB_ADMIN_GITHUB_IDS: "123456789"
```

The referenced Secret supplies `HYEB_ADMIN_SESSION_SECRET` plus secrets for enabled login methods. Helm rejects admin secrets and `HYEB_ADMIN_DB_PATH` in runtime configuration.

Validate before installing or upgrading:

```bash
pnpm test:helm
helm upgrade --install hyeboard deploy/helm/hyeboard \
  --namespace <namespace> \
  --values deploy/helm/hyeboard/values-production.yaml \
  --values <untracked-site-values.yaml>
```

## Use the control room

1. Open `/admin/login` and authenticate.
2. Open **Control** (`/admin`).
3. Select **Global** or a university tab.
4. Search for a capability or limit if needed.
5. Change switches or limit values. Changes remain staged locally.
6. Select **Review** and verify the exact diff and base revision.
7. Enter a concrete operational reason.
8. Select **Publish**.
9. Confirm the new revision under **History** and verify affected student UI/API behavior.

Use **Discard** to reset all staged changes to the current published revision.

If another admin publishes first, Hyeboard reports a revision conflict and preserves the draft. Review the refreshed current policy and its diff before publishing again; do not blindly reapply stale limits.

## Roll back

1. Open `/admin/history`.
2. Select the target revision.
3. Review its actor, timestamp, reason, and diff.
4. Select **Rollback**.
5. Review the rollback diff against the current revision.
6. Enter a new rollback reason.
7. Publish.

Rollback creates a new revision attributed to the current admin.

## Troubleshooting

### `Không thể kiểm tra phiên quản trị.`

This message means `GET /api/admin/session` failed. It is not a wrong-password message.

Check the public response first:

```bash
curl -i https://hyeboard.example.com/api/admin/session
```

Then check rollout, readiness, and API logs:

```bash
kubectl -n <namespace> get pods
kubectl -n <namespace> get deployment hyeboard-api
kubectl -n <namespace> logs deployment/hyeboard-api --all-pods=true --tail=200
kubectl -n <namespace> get --raw /api/v1/namespaces/<namespace>/services/hyeboard-api:80/proxy/api/ready
```

Common causes:

- `HYEB_ADMIN_SESSION_SECRET` is missing, shorter than 32 characters, or not visible to the new pods.
- The `hyeboard-runtime` Secret was updated but the API pods were not restarted.
- An OAuth provider has only part of its client-ID/client-secret/allowlist triple.
- `HYEB_ADMIN_PUBLIC_ORIGIN` contains a path, trailing slash, credentials, or the wrong scheme/host.
- PostgreSQL or Redis is unavailable, so distributed readiness fails closed.
- The ingress routes `/admin` to the web assets but does not route `/api/admin/*` to the API.

Do not print the Secret or pod environment while diagnosing it.

### Login method missing

- Password: confirm `HYEB_ADMIN_PASSWORD_HASH` exists and was generated by `admin:hash-password`.
- OAuth: confirm all three provider values exist and the numeric ID allowlist is valid.
- Restart the API pods after Secret changes.

### Login succeeds, then immediately returns to login

Confirm `HYEB_ADMIN_PUBLIC_ORIGIN` exactly matches the browser origin. Production must use HTTPS. Hyeboard intentionally ignores forwarded protocol headers when deciding admin cookie security.

### Policy page unavailable

Check `/api/ready`, PostgreSQL migrations, PostgreSQL connectivity, and Redis connectivity. Admin policy reads require live authority; they do not use the student-facing last-known-good fallback.

### Feature remains unavailable after enabling it

The adapter's evidence-backed capability must also be `true`. A university cannot override a global disable. Operational limits cannot exceed native or security ceilings.

## Operational safety

- Do not publish during degraded PostgreSQL or Redis health.
- Use reasons that identify the incident, maintenance, or request behind the change.
- Verify both API behavior and visible student UI after publishing.
- Use `/admin/auth` to confirm the active identity before sensitive changes and to sign out afterward.
- Treat `HYEB_ADMIN_SESSION_SECRET`, password hashes, OAuth client secrets, cookies, CSRF tokens, and audit-linked identities as sensitive operational data.

See [`ha-runbook.md`](ha-runbook.md#admin-feature-control) for authority, outage, backup, and recovery details.
