import { describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  getProfileHtml: vi.fn(),
  getGradesHtml: vi.fn(),
  getStudyProgressHtml: vi.fn(),
}));

vi.mock("./daotao-client", () => ({
  DaotaoClient: vi.fn().mockImplementation(() => clientMocks),
}));

import { createVnuAdapter } from "./adapter";

describe("vnu adapter dashboard policy projection", () => {
  it("does not start disabled dashboard upstream work", async () => {
    const adapter = createVnuAdapter();
    const capabilities = Object.fromEntries(Object.keys(adapter.university.capabilities).map((key) => [key, false]));

    const dashboard = await adapter.getDashboard({ capabilities });

    expect(dashboard).toMatchObject({ todaySchedule: [], courses: [], assignments: [], grades: [], exams: [], notifications: [] });
    expect(clientMocks.getProfileHtml).not.toHaveBeenCalled();
    expect(clientMocks.getGradesHtml).not.toHaveBeenCalled();
    expect(clientMocks.getStudyProgressHtml).not.toHaveBeenCalled();
  });
});
