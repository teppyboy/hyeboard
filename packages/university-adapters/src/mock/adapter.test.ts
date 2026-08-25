import { describe, expect, it } from "vitest";
import { createMockAdapter } from "./adapter";

describe("mock adapter dashboard policy projection", () => {
  it("omits disabled dashboard fields", async () => {
    const adapter = createMockAdapter();
    const capabilities = { ...adapter.university.capabilities, grades: false, courses: false };

    const dashboard = await adapter.getDashboard({ capabilities });

    expect(dashboard.grades).toEqual([]);
    expect(dashboard.gpa).toBeUndefined();
    expect(dashboard.courses).toEqual([]);
    expect(dashboard.courseCount).toBeUndefined();
  });
});
