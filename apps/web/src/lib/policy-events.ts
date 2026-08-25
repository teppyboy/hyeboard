import type { StoredAccount } from "./api-types";
import { ACCOUNT_SWITCHED_EVENT, SESSION_TOKEN_ROTATED_EVENT } from "./api";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";
const MAX_RECONNECT_DELAY_MS = 30_000;
const POLL_INTERVAL_MS = 60_000;

export function policyReconnectDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, Math.min(attempt, 5)), MAX_RECONNECT_DELAY_MS);
}

type PolicyEventOptions = {
  getAccount: () => StoredAccount | undefined;
  onRevision: (revision: number) => void | Promise<void>;
  onPoll?: (account: StoredAccount, signal: AbortSignal) => void | Promise<void>;
  fetcher?: typeof fetch;
};

export function subscribeToPolicyEvents(options: PolicyEventOptions): () => void {
  const origin = options.getAccount();
  if (!origin?.token) return () => {};
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  let streamController: AbortController | undefined;
  let highestRevision = -1;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollController: AbortController | undefined;
  let pollAttempt = 0;

  const ownedAccount = () => {
    const current = options.getAccount();
    return current?.id === origin.id && current.token ? current : undefined;
  };
  const stop = () => controller.abort();
  const scheduleReconnect = () => {
    if (controller.signal.aborted || !ownedAccount()) return;
    schedulePoll(POLL_INTERVAL_MS);
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, policyReconnectDelay(reconnectAttempt));
    reconnectAttempt += 1;
  };
  const schedulePoll = (delay: number) => {
    if (controller.signal.aborted || !options.onPoll || pollTimer !== undefined || pollController !== undefined) return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      const account = ownedAccount();
      if (!account || controller.signal.aborted) return;
      const requestController = new AbortController();
      pollController = requestController;
      Promise.resolve().then(() => options.onPoll?.(account, requestController.signal)).then(() => {
        if (pollController !== requestController || controller.signal.aborted) return;
        pollController = undefined;
        pollAttempt = 0;
        schedulePoll(POLL_INTERVAL_MS);
      }).catch(() => {
        if (pollController !== requestController || controller.signal.aborted) return;
        pollController = undefined;
        schedulePoll(policyReconnectDelay(pollAttempt));
        pollAttempt += 1;
      });
    }, delay);
  };
  const connect = async () => {
    const account = ownedAccount();
    if (controller.signal.aborted || !account) return;
    const requestController = new AbortController();
    streamController = requestController;
    try {
      const response = await fetcher(`${API_BASE_URL}/api/policy/events`, {
        signal: requestController.signal,
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${account.token}`,
          ...(highestRevision < 0 ? {} : { "Last-Event-ID": String(highestRevision) }),
        },
      });
      if (!response.ok || !response.body) throw new Error(`Policy event stream failed: ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!controller.signal.aborted && streamController === requestController && ownedAccount()) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          if (streamController !== requestController || !ownedAccount()) return;
          const lines = event.split(/\r?\n/);
          if (!lines.includes("event: revision")) continue;
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const value = line.slice(6);
            if (!/^(0|[1-9]\d*)$/.test(value)) continue;
            const revision = Number(value);
            if (!Number.isSafeInteger(revision) || revision <= highestRevision) continue;
            await options.onRevision(revision);
            highestRevision = revision;
            reconnectAttempt = 0;
          }
        }
      }
      if (!controller.signal.aborted && streamController === requestController) scheduleReconnect();
    } catch {
      if (!controller.signal.aborted && streamController === requestController) scheduleReconnect();
    }
  };
  const reconnect = () => {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    streamController?.abort();
    streamController = undefined;
    pollController?.abort();
    pollController = undefined;
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
    reconnectAttempt = 0;
    pollAttempt = 0;
    schedulePoll(POLL_INTERVAL_MS);
    void connect();
  };
  const reconnectWithCurrentToken = (event: Event) => {
    const detail = (event as CustomEvent<{ accountId?: unknown }>).detail;
    if (detail?.accountId === origin.id && ownedAccount()) reconnect();
  };
  const accountSwitched = () => {
    if (ownedAccount()) reconnect();
    else stop();
  };

  window.addEventListener(ACCOUNT_SWITCHED_EVENT, accountSwitched);
  window.addEventListener(SESSION_TOKEN_ROTATED_EVENT, reconnectWithCurrentToken);
  controller.signal.addEventListener("abort", () => {
    streamController?.abort();
    window.removeEventListener(ACCOUNT_SWITCHED_EVENT, accountSwitched);
    window.removeEventListener(SESSION_TOKEN_ROTATED_EVENT, reconnectWithCurrentToken);
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollController?.abort();
  }, { once: true });
  schedulePoll(POLL_INTERVAL_MS);
  void connect();
  return stop;
}
