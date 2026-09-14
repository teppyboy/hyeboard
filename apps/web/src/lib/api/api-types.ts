import type { ApiErrorDetails, AuthResult as SchemaAuthResult } from "@hyeboard/schemas";

const vnuRefreshAttemptedMarker: unique symbol = Symbol("vnuRefreshAttempted");

export type { ApiErrorDetails } from "@hyeboard/schemas";
export type AuthResult = SchemaAuthResult;

export type StoredAccount = {
  id: string;
  universityId: string;
  token: string;
  studentCode?: string;
  addedAt: string;
};

export type ImportedAccountResult = {
  account: StoredAccount;
  auth: AuthResult;
};

export type ImportSessionInput = {
  studentCode?: string;
  studenthubGoogleCredential?: string;
  studenthubToken?: string;
  studenthubCookie?: string;
  canvasToken?: string;
  canvasCookie?: string;
  canvasCsrfToken?: string;
  vnuUsername?: string;
  vnuPassword?: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
    public readonly details?: ApiErrorDetails,
    options?: { vnuRefreshAttempted?: boolean },
  ) {
    super(message);
    this.name = "ApiError";
    Object.defineProperty(this, vnuRefreshAttemptedMarker, {
      value: options?.vnuRefreshAttempted === true,
      writable: true,
      enumerable: false,
      configurable: false,
    });
  }
}

export function markVnuRefreshAttempted<T extends ApiError>(error: T): T {
  (error as T & { [vnuRefreshAttemptedMarker]: boolean })[vnuRefreshAttemptedMarker] = true;
  return error;
}

export function wasVnuRefreshAttempted(error: unknown): boolean {
  return error instanceof ApiError
    && (error as ApiError & { [vnuRefreshAttemptedMarker]: boolean })[vnuRefreshAttemptedMarker] === true;
}
