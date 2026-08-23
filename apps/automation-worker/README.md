# Automation Worker

This package is a Node-only execution boundary for encrypted automation jobs.

## Integration hooks

- Construct `RedisStreamsBroker` with a connected node-redis client supplied by the host application. The package intentionally has no direct `redis` dependency and does not create a Redis connection.
- Construct `AutomationEnvelopeCodec` with the keyring parsed by `parseAutomationWorkerConfig`.
- Provide the actual UET implementation through `AutomationExecutor`. Selectors, login steps, CAPTCHA handling, and response mapping are deliberately not included here.
- Provide `createBrowserlessPuppeteerProvider` with `puppeteer.connect` (or a compatible connector). The Browserless token remains in the provider closure and is not present in connection metadata.
- Call `start()`, install `installProcessSignalHandlers()`, and call `stop()` during application shutdown. `stop()` cancels active work, waits up to the configured drain timeout, and leaves shutdown-interrupted stream entries pending.

The executable host bridge is available through `src/cli.ts` (bundled as `dist/cli.cjs`). It owns the Redis clients and Browserless/Puppeteer provider, creates the UET executor, and starts the worker/control lifecycle. The UET adapter receives the provider-owned Puppeteer session and verifies ownership before browser operations.

## Message contract

The job stream entry must contain `jobEnvelope`, an encrypted `UetImportJob` envelope using the configured job AAD. The job's `credentialEnvelope` is opened only inside the executor boundary. Successful executor output is encrypted before the `succeeded` event is emitted.

The event sink is injectable. `StreamAutomationEventSink` writes JSON events to a Redis Stream, while `InMemoryAutomationEventSink` is intended for tests.

## Limitations

- Redis Streams command methods are represented by a small structural interface so this package does not add or duplicate the existing repository Redis dependency. The host owns client connection, reconnect, TLS, ACL, and metrics policy.
- Browserless endpoint construction is abstracted around Puppeteer's `connect`; this package does not bundle Puppeteer or prescribe browser/page types.
- Fencing is represented in leases and every protocol event. Event/result consumers must reject stale fences atomically with their own state transition.
- Retryable failures remain pending until reclaim and are not emitted as terminal events. A final failure is acknowledged after `maxDeliveryCount`.
- Cancellation is cooperative. An executor that ignores `AbortSignal` can outlive the configured drain timeout; it will not be acknowledged after shutdown.

## Containers

`apps/automation-worker/Dockerfile` builds the executable bridge as a non-root Node `22.22.0-bookworm-slim` image. It starts `node dist/cli.cjs`, listens on port `8080`, and exposes `/healthz` and `/readyz` for container probes.

Build the image from the repository root and publish it with an immutable SHA tag:

```bash
docker build -f apps/automation-worker/Dockerfile \
  -t ghcr.io/im-yuuki/hyeboard-automation-worker:sha-<40-character-commit-sha> .
docker push ghcr.io/im-yuuki/hyeboard-automation-worker:sha-<40-character-commit-sha>
```

The worker needs Redis, Browserless/Puppeteer, the current automation key pair, and its stream/health configuration. Prefer the repository `docker-compose.yml` `distributed` profile for local container orchestration; it supplies the private network endpoints and health checks. Kubernetes uses the same image through `deploy/k8s/base` and its `example`, `staging`, and `production` overlays. The production overlay runs Browserless in-cluster and consumes Redis through the operator-managed primary Service; PostgreSQL, TLS, the Redis Operator, and secrets remain operator-managed prerequisites.

The Compose/Kubernetes defaults keep `HYEB_AUTOMATION_EXECUTOR_READY=false` on the API. The worker image and a reachable Browserless service are not a claim of Browserless/UET parity; automated university login requires a separate target-environment gate.
