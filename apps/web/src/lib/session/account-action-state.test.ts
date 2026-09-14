import { describe, expect, it } from "vitest";
import { operationMayClearOwner, operationOwnsFailure, operationOwnsPendingEntry, type AccountActionOperation } from "./account-action-state";

function operation(source: AccountActionOperation["source"] = "account-menu"): AccountActionOperation {
  return { generation: Symbol("operation"), accountId: "account-a", accountToken: "token-a", source };
}

describe("account action ownership", () => {
  it("publishes failure only for the exact pending generation and account token", () => {
    const current = operation();
    expect(operationOwnsFailure({ operation: current, currentOperation: current, pendingGeneration: current.generation, currentAccountToken: current.accountToken, activeAccountId: "account-b" })).toBe(true);
    expect(operationOwnsFailure({ operation: current, currentOperation: current, pendingGeneration: Symbol("newer"), currentAccountToken: current.accountToken, activeAccountId: "account-b" })).toBe(false);
    expect(operationOwnsFailure({ operation: current, currentOperation: current, pendingGeneration: current.generation, currentAccountToken: "rotated", activeAccountId: "account-b" })).toBe(false);
  });

  it("keeps superseded and closed owners inert", () => {
    const older = operation();
    const newer = operation();
    expect(operationOwnsFailure({ operation: older, currentOperation: newer, pendingGeneration: older.generation, currentAccountToken: older.accountToken, activeAccountId: older.accountId })).toBe(false);
    expect(operationOwnsFailure({ operation: older, currentOperation: undefined, pendingGeneration: older.generation, currentAccountToken: older.accountToken, activeAccountId: older.accountId })).toBe(false);
  });

  it("requires a settings operation to retain active-account ownership", () => {
    const current = operation("settings");
    expect(operationOwnsFailure({ operation: current, currentOperation: current, pendingGeneration: current.generation, currentAccountToken: current.accountToken, activeAccountId: "account-b" })).toBe(false);
    expect(operationOwnsFailure({ operation: current, currentOperation: current, pendingGeneration: current.generation, currentAccountToken: current.accountToken, activeAccountId: current.accountId })).toBe(true);
  });

  it("clears only matching pending and non-error owner state", () => {
    const current = operation();
    expect(operationOwnsPendingEntry(current, current.generation)).toBe(true);
    expect(operationOwnsPendingEntry(current, Symbol("newer"))).toBe(false);
    expect(operationMayClearOwner(current, current, false)).toBe(true);
    expect(operationMayClearOwner(current, current, true)).toBe(false);
    expect(operationMayClearOwner(current, operation(), false)).toBe(false);
  });
});
