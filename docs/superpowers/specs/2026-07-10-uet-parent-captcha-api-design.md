# UET Parent CAPTCHA API Design

## Problem

Hyeboard currently signs parent and guardian accounts into StudentHub through browser automation. Both Puppeteer and Patchright select the first `img` in the document as the CAPTCHA. CDP confirmed the CAPTCHA is the sole `form img[alt="captcha"]`, sized 160x56; the document's first image is the UET logo. These dimensions are evidence, not a runtime API contract.

HAR and live CDP inspection show that browser automation is unnecessary for this login path. StudentHub exposes the complete challenge flow through JSON APIs:

1. `GET /api/auth/captcha` returns a challenge ID and a PNG data URI.
2. `POST /api/auth/login` accepts the username, password, challenge ID, and CAPTCHA answer.
3. StudentHub returns HTTP 200 for both success and application-level failure, so callers must inspect the response body code and data.
4. A rejected or expired CAPTCHA invalidates the challenge. The next attempt must fetch a new challenge.

Raw HAR values must never be logged or committed. The new parent flow must not log credentials, CAPTCHA answers, challenge IDs, image payloads, account data, response bodies, or access tokens.

## Scope

Replace only the UET parent and guardian direct-login implementation. Preserve the student Google automation path, session format, SSE progress transport, human CAPTCHA modal, rate limiting, and encrypted credential refresh behavior.

## Architecture

### StudentHub Client

Add a typed CAPTCHA challenge request to `StudentHubClient`:

- Call `GET /api/auth/captcha` with the existing browser-like StudentHub headers.
- Require a non-empty challenge ID.
- Require a non-empty, valid base64 image beginning with `data:image/png;base64,` and cap the encoded payload at 256 KiB. Do not require fixed image dimensions.
- Treat transport, non-JSON, or malformed payload failures as `STUDENTHUB_REQUEST_FAILED` without logging response bodies.

Change `authenticateDirect` to accept a challenge ID and answer, then submit:

```json
{
  "userName": "...",
  "password": "...",
  "captchaId": "...",
  "captchaValue": "..."
}
```

Parse `/api/auth/login` directly instead of using `request()` or `unwrapStudentHubEnvelope()`, because those helpers discard the application code. Return only the normalized result needed by the adapter: `{ code, login?: { accessToken, accountCode } }`. Do not retain the full PII-bearing login response. A response without an access token or application code is malformed. Do not infer success from HTTP status or log response content.

### CAPTCHA Resolution

Create a Worker-safe `captcha.ts` module for the solver type, registration, and answer resolution. It must have no Node or Tesseract imports. Keep `captcha-ocr.ts` Node-only; `apps/worker/src/index.node.ts` dynamically imports and registers it. Bundle that local module into the standalone Node artifact, but keep its `tesseract.js` import dynamic, external, and optional. This preserves the runtime boundary, removes workspace-package imports from the packaged artifact, and keeps Tesseract, WASM, and trained-data assets out of the Cloudflare Worker bundle.

For each challenge:

1. Try registered OCR when available.
2. If OCR is unavailable or below confidence threshold, call `ImportSessionContext.onCaptchaNeeded` to relay the data URI through the existing SSE flow.
3. If neither path can provide an answer, throw `STUDENTHUB_CAPTCHA_REQUIRED`.

Track whether OCR supplied the rejected answer. When attempt 1 used OCR and returns `EX102`, attempt 2 must skip OCR and call `onCaptchaNeeded` directly when that callback exists. Without a callback, OCR may run against the fresh second challenge.

Keep StudentHub's upstream `captchaId` attempt-local inside the adapter. `onCaptchaNeeded` receives only the image. The Worker's SSE `challengeId` is a server-signed Hyeboard relay token containing a separately generated opaque relay ID and an HMAC-SHA256 signature; it must never reuse or expose the upstream ID.

### CAPTCHA Relay Coordination

Cloudflare uses one SQLite-backed Durable Object per opaque Hyeboard relay ID. The Worker reaches it through the generated `CAPTCHA_RELAY` binding and RPC. `prepare` persists pending state and expiry before the SSE event is exposed; `wait`, `answer`, and `cancel` coordinate across Worker isolates. The public solve route verifies a domain-separated HMAC using `HYEB_SESSION_SECRET` before any namespace lookup, returning challenge-not-found for malformed or forged tokens. Node and Bun use an abort-aware in-memory coordinator with explicit timer cleanup.

Cancelling the SSE reader or aborting its request cancels the active relay. After cancellation, the Worker suppresses progress/error writes and does not enqueue or close the stream controller again. The solve endpoint awaits coordinator completion so a separate isolate can answer the same relay ID. An answered DO retains its expiry alarm until `wait` consumes the answer; cancellation resolves current waiters and immediately deletes row and alarm.

The web login owns a caller abort controller and links it to a three-minute deadline covering Google automation plus one human relay. Superseded logins and component unmount abort the stream, modal, and answer POST; deadline and caller-abort errors remain typed `ApiError`s.

### Parent Login Flow

The `PH`-prefixed adapter branch no longer requires `BrowserConnection`.

Use at most two attempts:

1. Fetch a fresh CAPTCHA challenge.
2. Resolve its answer.
3. Submit credentials, challenge ID, and answer.
4. Return the session when login data contains an access token.
5. If StudentHub returns CAPTCHA failure code `EX102`, discard the challenge and repeat from step 1 once.
6. After a second `EX102`, throw an explicit CAPTCHA rejection error.
7. Map other application-level login rejection to `INVALID_STUDENTHUB_CREDENTIAL`.

Session construction remains unchanged: preserve the encrypted parent credential, StudentHub bearer token, JWT-derived upstream expiry when available, and 30-day outer session expiry.

### Removed Browser Path

Delete parent direct-login functions, types, and Patchright launcher registration from the Google automation modules. Google StudentHub and Canvas automation remains unchanged.

The Worker continues to use SSE for all UET credential imports because parent login may pause for human CAPTCHA input. It may still pass a browser connection in the import context; the parent branch ignores it. Update comments that describe an invisible CAPTCHA or a browser requirement.

## Error Handling

- `STUDENTHUB_CAPTCHA_REQUIRED`: no OCR or interactive answer source exists.
- `STUDENTHUB_CAPTCHA_REJECTED`: StudentHub rejected two fresh CAPTCHA attempts.
- `INVALID_STUDENTHUB_CREDENTIAL`: non-CAPTCHA application-level login rejection.
- `STUDENTHUB_REQUEST_FAILED`: network, HTTP, JSON, or response-shape failure.
- Existing human-relay timeout and expired challenge errors remain unchanged.
- `STUDENTHUB_CAPTCHA_CANCELLED`: the client disconnected or cancelled the SSE reader while a relay was pending.
- `GOOGLE_AUTOMATION_TIMEOUT`: the client-side three-minute login deadline elapsed.

`STUDENTHUB_CAPTCHA_REQUIRED` and `STUDENTHUB_CAPTCHA_REJECTED` use HTTP 422. `INVALID_STUDENTHUB_CREDENTIAL` uses 401. Transport, non-JSON, and malformed response failures use 502. Upstream non-2xx responses use `STUDENTHUB_REQUEST_FAILED` with the upstream status, matching existing `StudentHubClient` behavior. Only a well-formed no-token response with a non-`EX102` application code is a credential rejection.

No new parent-flow error or diagnostic log may contain credentials, CAPTCHA answers, upstream or relay challenge IDs, image data, account fields, response bodies, or tokens. Existing Google automation logging is outside this change.

## Refresh Behavior

Parent sessions continue storing encrypted credentials for lazy token refresh. Refresh uses the same direct CAPTCHA API flow without browser automation.

- A Node deployment with OCR may refresh silently.
- A deployment without OCR cannot ask a user during lazy refresh on the next authenticated request and returns `STUDENTHUB_CAPTCHA_REQUIRED`.
- This limitation already exists in the current browser implementation; the API conversion does not expand scope into asynchronous refresh UI.

## Tests

Add focused tests that verify:

- Parent login works without a browser connection.
- CAPTCHA challenge response validation rejects missing IDs, non-PNG data URIs, malformed or empty base64, and payloads larger than 256 KiB.
- Login sends all four required fields with the matching challenge.
- HTTP 200 with successful login data creates the existing parent session shape.
- `EX102` causes a new challenge fetch before the second submission.
- Rejected OCR skips the solver and uses human input for the interactive retry, with exact solver/callback ordering and call counts asserted.
- Upstream CAPTCHA IDs remain adapter-local; the SSE relay exposes only a signed Hyeboard relay token and the image. Forged or malformed tokens never call the coordinator.
- Real Workers-pool tests verify Cloudflare relay persistence, answer-before-wait, separate binding stubs, unconsumed-answer alarm cleanup, immediate cancellation cleanup, alarm timeout, duplicate calls, and schema preservation.
- Local relay tests verify answer-before-wait and cancel-before-wait timer cleanup; SSE reader cancellation removes pending state and causes no later stream-controller write or close.
- Web tests verify a deferred CAPTCHA modal does not block server errors or closure, answer POST failures cancel the reader, duplicate relay events open one prompt, stream failure aborts the prompt, caller cancellation propagates, and the three-minute deadline aborts.
- Two CAPTCHA failures return `STUDENTHUB_CAPTCHA_REJECTED`.
- Other application failures return `INVALID_STUDENTHUB_CREDENTIAL`.
- A missing application code and access token is treated as malformed upstream data, not invalid credentials.
- Fake sentinel credentials, answer, upstream ID, image, account fields, token, and raw body never appear in logs on success or failure.
- Lazy parent refresh supplies no human callback, needs no browser, propagates CAPTCHA errors unchanged, and does not convert them into session-death errors.
- Student Google automation still requires a browser connection and remains behaviorally unchanged.

Run `pnpm build`, `pnpm test`, the web Playwright suite, and `pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run`. Start `wrangler dev` using compatibility date `2026-07-02`. Confirm the Cloudflare bundle contains no Tesseract, WASM, or trained-data modules. Build the Node artifact and run its isolated package check with OCR disabled and with optional `tesseract.js` installed; statically verify bundled local registration plus the dynamic bare import, then import the linked optional module without invoking OCR. No visible web structure changes are expected; keep stream lifecycle tests separate from Playwright smoke selectors.
