export type AccountActionSource = "account-menu" | "settings";

export type AccountActionOperation = Readonly<{
  generation: symbol;
  accountId: string;
  accountToken: string;
  source: AccountActionSource;
}>;

export type AccountActionOwnershipInput = Readonly<{
  operation: AccountActionOperation;
  currentOperation: AccountActionOperation | undefined;
  pendingGeneration: symbol | undefined;
  currentAccountToken: string | undefined;
  activeAccountId: string | null;
}>;

export function operationOwnsFailure(input: AccountActionOwnershipInput): boolean {
  if (input.currentOperation?.generation !== input.operation.generation) return false;
  if (input.pendingGeneration !== input.operation.generation) return false;
  if (input.currentAccountToken !== input.operation.accountToken) return false;
  if (input.operation.source === "settings" && input.activeAccountId !== input.operation.accountId) return false;
  return true;
}

export function operationOwnsPendingEntry(operation: AccountActionOperation, pendingGeneration: symbol | undefined): boolean {
  return pendingGeneration === operation.generation;
}

export function operationMayClearOwner(
  operation: AccountActionOperation,
  currentOperation: AccountActionOperation | undefined,
  publishedError: boolean,
): boolean {
  return !publishedError && currentOperation?.generation === operation.generation;
}
