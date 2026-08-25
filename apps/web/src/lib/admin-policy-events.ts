import { adminApi } from "./admin-api";
import { policyReconnectDelay } from "./policy-events";

const POLL_INTERVAL_MS = 60_000;

type AdminPolicyEventOptions = {
  getRevision: () => number | undefined;
  onRevision: (revision: number) => void | Promise<void>;
  onPoll: (signal: AbortSignal) => void | Promise<void>;
  connect?: typeof adminApi.events;
};

export function subscribeToAdminPolicyEvents(options: AdminPolicyEventOptions): () => void {
  const controller = new AbortController();
  const connect = options.connect ?? adminApi.events;
  let streamController: AbortController | undefined;
  let highestRevision = options.getRevision() ?? -1;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollController: AbortController | undefined;
  let pollAttempt = 0;

  const schedulePoll = (delay: number) => {
    if (controller.signal.aborted || pollTimer !== undefined || pollController !== undefined) return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      if (controller.signal.aborted) return;
      const requestController = new AbortController();
      pollController = requestController;
      Promise.resolve().then(() => options.onPoll(requestController.signal)).then(() => {
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
  const scheduleReconnect = () => {
    if (controller.signal.aborted) return;
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void open();
    }, policyReconnectDelay(reconnectAttempt));
    reconnectAttempt += 1;
  };
  const open = async () => {
    if (controller.signal.aborted) return;
    const requestController = new AbortController();
    streamController = requestController;
    try {
      const response = await connect(requestController.signal, highestRevision < 0 ? undefined : highestRevision);
      if (!response.body) throw new Error("Admin policy event stream has no body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!controller.signal.aborted && streamController === requestController) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          if (streamController !== requestController) return;
          const lines = event.split(/\r?\n/);
          if (!lines.includes("event: revision")) continue;
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const value = line.slice(6);
            if (!/^(0|[1-9]\d*)$/.test(value)) continue;
            const revision = Number(value);
            const currentRevision = Math.max(highestRevision, options.getRevision() ?? -1);
            if (!Number.isSafeInteger(revision) || revision <= currentRevision) continue;
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

  controller.signal.addEventListener("abort", () => {
    streamController?.abort();
    pollController?.abort();
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    if (pollTimer !== undefined) clearTimeout(pollTimer);
  }, { once: true });
  schedulePoll(POLL_INTERVAL_MS);
  void open();
  return () => controller.abort();
}
