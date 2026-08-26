import type { FeaturePolicyContent } from "@hyeboard/schemas";
import { describe, expect, it } from "vitest";
import { rebasePolicyDraft } from "./admin-control";

const policy = (...disabled: string[]): FeaturePolicyContent => ({
  global: { capabilities: Object.fromEntries(disabled.map((key) => [key, { enabled: false }])), limits: {} },
  universities: {},
});

describe("rebasePolicyDraft", () => {
  it("rebases a clean draft onto a refreshed authoritative snapshot", () => {
    const previous = policy();
    const refreshed = { revision: 5, ...policy("grades") };

    const result = rebasePolicyDraft({ revision: 4, policy: previous }, previous, refreshed);

    expect(result).toEqual({ base: { revision: 5, policy: policy("grades") }, draft: policy("grades") });
  });

  it("preserves a dirty draft and its publication base across refreshes", () => {
    const base = { revision: 4, policy: policy() };
    const draft = policy("tuition");

    const result = rebasePolicyDraft(base, draft, { revision: 5, ...policy("grades") });

    expect(result.base).toBe(base);
    expect(result.draft).toBe(draft);
  });
});
