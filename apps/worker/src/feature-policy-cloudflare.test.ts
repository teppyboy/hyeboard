import { describe, expect, it, vi } from "vitest";
import { DurableObjectFeaturePolicyEvents, DurableObjectFeaturePolicyStore } from "./feature-policy-cloudflare";

function namespace() {
  const stub = {
    current: vi.fn(),
    publish: vi.fn(),
    history: vi.fn(),
    revision: vi.fn(),
    consumeAdminLoginAttempt: vi.fn(),
    publishRevision: vi.fn(),
  };
  const binding = {
    idFromName: vi.fn(() => ({}) as DurableObjectId),
    get: vi.fn(() => stub),
  };
  return { binding: binding as unknown as Env["FEATURE_POLICY"], stub, get: binding.get };
}

describe("Durable Object feature policy bindings", () => {
  it("defers stub creation until a runtime operation", async () => {
    const storeBinding = namespace();
    const eventsBinding = namespace();
    const store = new DurableObjectFeaturePolicyStore(storeBinding.binding);
    const events = new DurableObjectFeaturePolicyEvents(eventsBinding.binding);

    expect(storeBinding.get).not.toHaveBeenCalled();
    expect(eventsBinding.get).not.toHaveBeenCalled();

    storeBinding.stub.current.mockResolvedValue({ revision: 0, global: { capabilities: {}, limits: {} }, universities: {} });
    eventsBinding.stub.publishRevision.mockResolvedValue(undefined);
    await store.current();
    await events.publish(1);

    expect(storeBinding.get).toHaveBeenCalledOnce();
    expect(eventsBinding.get).toHaveBeenCalledOnce();
  });
});
