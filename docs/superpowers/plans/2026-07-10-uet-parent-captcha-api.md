# UET Parent CAPTCHA API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace UET parent browser login with StudentHub's direct CAPTCHA challenge API while preserving OCR and human relay fallback.

**Architecture:** `StudentHubClient` owns upstream challenge and login HTTP parsing. A Worker-safe CAPTCHA module owns optional solver registration and answer-source selection. The UET adapter coordinates two fresh challenge attempts and session creation. Cloudflare relays human answers through one SQLite Durable Object per Hyeboard relay ID; Node/Bun use an abort-aware local coordinator.

**Tech Stack:** TypeScript, Fetch API, Elysia, Vitest, Tesseract.js (Node-only), Cloudflare Workers, pnpm

---

No commits are included because the user did not request git commits. Work in the existing dirty feature worktree without reverting unrelated changes.

## File Map

- Create `packages/university-adapters/src/uet/captcha.ts`: Worker-safe OCR registration and OCR/human answer selection.
- Create `packages/university-adapters/src/uet/captcha.test.ts`: answer ordering and error tests.
- Create `packages/university-adapters/src/uet/studenthub-client.test.ts`: upstream challenge/login request and parsing tests.
- Modify `packages/university-adapters/src/uet/studenthub-client.ts`: raw envelope fetch, challenge validation, CAPTCHA-aware login.
- Modify `packages/university-adapters/src/uet/types.ts`: narrow challenge and direct-login result types.
- Modify `packages/university-adapters/src/uet/adapter.ts`: two-attempt direct API orchestration.
- Modify `packages/university-adapters/src/uet/adapter.test.ts`: parent API flow and browser independence tests.
- Modify `packages/university-adapters/src/uet/google-login-automation.ts`: remove parent browser flow and CAPTCHA registry.
- Modify `packages/university-adapters/src/uet/google-login-automation-patchright.ts`: remove parent Patchright flow.
- Modify `packages/university-adapters/src/index.ts`: export CAPTCHA setter from Worker-safe module; remove parent launcher exports.
- Modify `apps/worker/src/index.node.ts`: retain lazy OCR registration; remove parent Patchright launcher registration.
- Modify `apps/worker/src/app.ts`, `packages/university-adapters/src/types.ts`, `packages/university-adapters/src/uet/captcha-ocr.ts`: correct stale browser/CAPTCHA comments.
- Create `apps/worker/src/captcha-relay-durable-object.ts` and `captcha-relay-cloudflare.ts`: persisted RPC relay and generated-binding coordinator.
- Create `apps/worker/src/captcha-relay.ts`: abort-aware Node/Bun coordinator and common relay contract.
- Modify `apps/worker/wrangler.jsonc` and regenerate `worker-configuration.d.ts`: binding plus SQLite migration.
- Modify `apps/web/src/lib/api.ts` and create `lib/uet-session-stream.ts`: race stream reads against one tracked CAPTCHA submission, propagate failures, abort prompts, and ignore duplicate relay events.
- Modify `apps/worker/scripts/build-node.mjs` and add `scripts/check-node-package.mjs`: bundle local OCR registration and verify isolated startup.

### Task 1: Worker-Safe CAPTCHA Resolver

- [ ] **Step 1: Add failing resolver tests**

Create tests that reset the global solver after each case and assert these exact paths:

```ts
setCaptchaOcrSolver(async () => "OCR1");
await expect(resolveCaptchaAnswer("data:image/png;base64,QQ==")).resolves.toEqual({ answer: "OCR1", source: "ocr" });

setCaptchaOcrSolver(async () => undefined);
await expect(resolveCaptchaAnswer("data:image/png;base64,QQ==", async () => " HUMAN ")).resolves.toEqual({ answer: "HUMAN", source: "human" });

await expect(resolveCaptchaAnswer("data:image/png;base64,QQ==", undefined, { skipOcr: true })).rejects.toMatchObject({ code: "STUDENTHUB_CAPTCHA_REQUIRED", status: 422 });
```

- [ ] **Step 2: Run resolver tests and verify failure**

Run: `pnpm --filter @hyeboard/university-adapters exec vitest run src/uet/captcha.test.ts`

Expected: FAIL because `captcha.ts` does not exist.

- [ ] **Step 3: Implement the Worker-safe resolver**

Create `captcha.ts` with no Tesseract or Node imports:

```ts
export type CaptchaOcrSolver = (imageDataUrl: string) => Promise<string | undefined>;
export type CaptchaAnswer = { answer: string; source: "ocr" | "human" };

let captchaOcrSolver: CaptchaOcrSolver | undefined;

export function setCaptchaOcrSolver(solver: CaptchaOcrSolver | undefined): void {
  captchaOcrSolver = solver;
}

export async function resolveCaptchaAnswer(
  imageDataUrl: string,
  onCaptchaNeeded?: (imageDataUrl: string) => Promise<string>,
  options: { skipOcr?: boolean } = {},
): Promise<CaptchaAnswer> {
  if (!options.skipOcr && captchaOcrSolver) {
    const answer = (await captchaOcrSolver(imageDataUrl).catch(() => undefined))?.trim();
    if (answer) return { answer, source: "ocr" };
  }
  const answer = (await onCaptchaNeeded?.(imageDataUrl))?.trim();
  if (answer) return { answer, source: "human" };
  throw new HyeboardError("STUDENTHUB_CAPTCHA_REQUIRED", "This sign-in requires a verification code that could not be completed automatically.", 422);
}
```

- [ ] **Step 4: Run resolver tests**

Run: `pnpm --filter @hyeboard/university-adapters exec vitest run src/uet/captcha.test.ts`

Expected: PASS.

### Task 2: StudentHub CAPTCHA API Client

- [ ] **Step 1: Add failing client tests**

Mock `globalThis.fetch` and cover:

```ts
fetchMock.mockResolvedValueOnce(jsonResponse({ code: "200", data: { captchaId: "upstream-id", image: "data:image/png;base64,iVBORw0KGgo=" } }));
await expect(new StudentHubClient().getCaptchaChallenge()).resolves.toEqual({ captchaId: "upstream-id", image: "data:image/png;base64,iVBORw0KGgo=" });

fetchMock.mockResolvedValueOnce(jsonResponse({ code: "200", data: { accessToken: "token", accountCode: "PH1", name: "sentinel-pii" } }));
await expect(client.authenticateDirect("PH1", "secret", "upstream-id", "ABCD")).resolves.toEqual({ code: "200", login: { accessToken: "token", accountCode: "PH1" } });
```

Inspect the POST body and require exactly `userName`, `password`, `captchaId`, and `captchaValue`. Add malformed tests for missing challenge ID, wrong MIME, empty/invalid base64, encoded image over 256 KiB, absent application code, and non-JSON data.

- [ ] **Step 2: Run client tests and verify failure**

Run: `pnpm --filter @hyeboard/university-adapters exec vitest run src/uet/studenthub-client.test.ts`

Expected: FAIL because methods and signatures do not match.

- [ ] **Step 3: Add narrow upstream types**

Add types equivalent to:

```ts
export type StudentHubCaptchaChallenge = { captchaId: string; image: string };
export type StudentHubDirectLoginResult = {
  code: string;
  login?: { accessToken: string; accountCode?: string };
};
```

- [ ] **Step 4: Implement raw JSON fetch and validation**

Split existing request logic so `requestJson(path, init)` handles fetch, non-2xx, and JSON parsing without unwrapping. Keep `request<T>` as `unwrapStudentHubEnvelope(await requestJson(...))` for existing endpoints.

Implement `getCaptchaChallenge()` by validating the envelope data, the `data:image/png;base64,` prefix, non-empty base64, base64 syntax/decodability, and 256 KiB encoded limit. Throw `STUDENTHUB_REQUEST_FAILED` with status 502 for malformed data.

Implement:

```ts
authenticateDirect(
  username: string,
  password: string,
  captchaId: string,
  captchaValue: string,
): Promise<StudentHubDirectLoginResult>
```

Parse the raw envelope. Normalize string/number `code` to a string. Return only `accessToken` and optional `accountCode`; discard all other account fields. A missing code or malformed success data throws `STUDENTHUB_REQUEST_FAILED`. Remove raw response-body and username logging.

- [ ] **Step 5: Run client tests**

Run: `pnpm --filter @hyeboard/university-adapters exec vitest run src/uet/studenthub-client.test.ts`

Expected: PASS.

### Task 3: Parent Adapter Orchestration

- [ ] **Step 1: Replace parent automation mocks with client and resolver mocks**

In `adapter.test.ts`, mock `StudentHubClient.getCaptchaChallenge`, `StudentHubClient.authenticateDirect`, and `resolveCaptchaAnswer`. Test parent import without `browserConnection`.

- [ ] **Step 2: Add failing retry tests**

Use two challenge IDs and assert this sequence:

```ts
getCaptchaChallenge: challenge-1, challenge-2
resolveCaptchaAnswer: first call skipOcr false, second call skipOcr true when first source is "ocr" and human callback exists
authenticateDirect: EX102, then successful token
```

Also test two `EX102` responses produce `STUDENTHUB_CAPTCHA_REJECTED`/422 and a different application code produces `INVALID_STUDENTHUB_CREDENTIAL`/401.

- [ ] **Step 3: Run adapter tests and verify failure**

Run: `pnpm --filter @hyeboard/university-adapters exec vitest run src/uet/adapter.test.ts`

Expected: FAIL because the adapter still requires browser automation.

- [ ] **Step 4: Implement two-attempt API flow**

For `PH` usernames, instantiate `StudentHubClient` without a session. On each attempt fetch a fresh challenge, resolve the answer, and call `authenticateDirect`. Return the existing parent session when `login.accessToken` exists. Retry only `EX102`; skip OCR on interactive attempt 2 after rejected OCR. Throw the specified CAPTCHA or credential errors otherwise. Do not pass the upstream challenge ID to callbacks or logs.

- [ ] **Step 5: Run adapter tests**

Run: `pnpm --filter @hyeboard/university-adapters exec vitest run src/uet/adapter.test.ts`

Expected: PASS.

### Task 4: Remove Obsolete Parent Browser Code

- [ ] **Step 1: Delete parent Puppeteer and Patchright implementations**

Remove `automateStudentHubDirectLogin`, its runner/resolver helpers, `PatchrightDirectLoginLauncher`, setter, and Patchright counterpart. Keep Google/Canvas automation behavior unchanged.

- [ ] **Step 2: Rewire exports and Node registration**

Export `setCaptchaOcrSolver` and its type from `captcha.ts`. Remove `setPatchrightDirectLoginLauncher` from `src/index.ts` and `apps/worker/src/index.node.ts`. Keep the lazy `captcha-ocr` dynamic import and existing build externals.

- [ ] **Step 3: Correct stale comments**

Update `apps/worker/src/app.ts`, `packages/university-adapters/src/types.ts`, and `captcha-ocr.ts` to describe direct CAPTCHA API login, SSE human relay, and lazy refresh without claiming browser or invisible CAPTCHA requirements.

- [ ] **Step 4: Run focused package tests**

Run: `pnpm --filter @hyeboard/university-adapters test`

Expected: typecheck and all Vitest tests PASS.

### Task 5: Integration and Security Verification

- [ ] **Step 1: Verify all workspace types and builds**

Run: `pnpm build`

Expected: all package and app builds PASS.

Run: `pnpm test`

Expected: all workspace typechecks/tests PASS.

- [ ] **Step 2: Verify browser behavior**

Run: `pnpm --filter @hyeboard/web exec playwright test`

Expected: all smoke tests PASS.

- [ ] **Step 3: Verify Cloudflare bundle isolation**

Run: `pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run`

Expected: dry run PASS. Inspect generated output and dependency diagnostics; no Tesseract, WASM, trained-data, or Patchright direct-login module enters the Cloudflare bundle.

- [ ] **Step 4: Review final diff**

Run `git diff --check` and inspect `git diff` plus `git status --short`. Confirm no HAR, raw CAPTCHA payload, credentials, tokens, `eng.traineddata`, generated build output, or unrelated files are staged or added.

### Task 6: Production Relay and Package Boundary

- [ ] Configure `CAPTCHA_RELAY` with a `new_sqlite_classes` migration and regenerate Worker types.
- [ ] Persist relay state before SSE event delivery; coordinate `prepare`, `wait`, `answer`, and `cancel` over Durable Object RPC.
- [ ] Keep Node/Bun local coordination abort-aware and clear timers on answer, timeout, or cancellation.
- [ ] Cancel active relays from `ReadableStream.cancel()` and request abort; suppress all later controller operations.
- [ ] Await `/api/uet/auth/solve-captcha` and frontend answer POST failures; cancel the reader and surface the error.
- [ ] Bundle `captcha-ocr.ts`, externalize only lazy `tesseract.js`, and run isolated OCR-off/OCR-on startup checks.
- [ ] Run web stream lifecycle tests and real `@cloudflare/vitest-pool-workers` Durable Object integration tests in separate Vitest configs.
- [ ] Sign public relay tokens with a domain-separated HMAC; verify before namespace lookup and bound relay-token/answer request fields.
- [ ] Keep answered-row alarms until consumption, immediately clean cancelled rows, and test both paths in real workerd.
- [ ] Link login fetch, stream, modal, and answer POST to caller cancellation plus a three-minute deadline; abort superseded/unmounted logins.
- [ ] Use compatibility date `2026-07-02`, regenerate types, and prove actual `wrangler dev` startup.
- [ ] Keep `tesseract.js` optional in source and packaged manifests while preserving isolated OCR registration checks.
