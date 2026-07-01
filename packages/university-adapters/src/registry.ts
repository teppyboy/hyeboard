import { HyeboardError } from "@hyeboard/core";
import { createMockAdapter } from "./mock/adapter";
import { createUetAdapter } from "./uet/adapter";
import type { UniversityAdapter } from "./types";

const adapters: Record<string, UniversityAdapter> = {
  mock: createMockAdapter(),
  uet: createUetAdapter(),
};

export function listUniversities() {
  return Object.values(adapters).map((adapter) => adapter.university);
}

export function getAdapter(universityId: string): UniversityAdapter {
  const adapter = adapters[universityId];
  if (!adapter) throw new HyeboardError("UNKNOWN_UNIVERSITY", `Unknown university: ${universityId}`, 404);
  return adapter;
}
