import {
  apiErrorDetailsSchema,
  type AdminPolicyView,
  type AdminSessionStatus,
  type ApiErrorDetails,
  type ApiResponse,
  type FeaturePolicyAuditEntry,
  type FeaturePolicyContent,
  type PublishFeaturePolicyInput,
  type RollbackFeaturePolicyInput,
} from "@hyeboard/schemas";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export type AdminHistoryPage = {
  items: FeaturePolicyAuditEntry[];
  nextBeforeRevision?: number;
};

export class AdminApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
    public readonly details?: ApiErrorDetails,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

function adminError(payload: ApiResponse<unknown>, response: Response): AdminApiError {
  const details = apiErrorDetailsSchema.safeParse(payload.error?.details);
  return new AdminApiError(
    payload.error?.message ?? `Request failed: ${response.status}`,
    payload.error?.code,
    response.status,
    details.success ? details.data : undefined,
  );
}

async function failedAdminResponse(response: Response): Promise<AdminApiError> {
  try {
    return adminError(await response.json() as ApiResponse<unknown>, response);
  } catch {
    return new AdminApiError(`Request failed: ${response.status} ${response.statusText}`, undefined, response.status);
  }
}

async function adminRequest<T>(path: string, init: RequestInit = {}, csrf?: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(csrf ? { "X-Hyeboard-CSRF": csrf } : {}),
      ...init.headers,
    },
  });
  let payload: ApiResponse<T>;
  try {
    payload = await response.json() as ApiResponse<T>;
  } catch {
    throw new AdminApiError(`Request failed: ${response.status} ${response.statusText}`, undefined, response.status);
  }
  if (!response.ok || payload.error) throw adminError(payload, response);
  return payload.data as T;
}

function post<T>(path: string, body: unknown, csrf?: string): Promise<T> {
  return adminRequest<T>(path, { method: "POST", body: JSON.stringify(body) }, csrf);
}

export const adminApi = {
  session: () => adminRequest<AdminSessionStatus>("/api/admin/session"),
  loginPassword: (password: string) => post<AdminSessionStatus>("/api/admin/login/password", { password }),
  logout: (csrf: string) => post<{ authenticated: false }>("/api/admin/logout", {}, csrf),
  policy: () => adminRequest<AdminPolicyView>("/api/admin/policy"),
  validate: (policy: FeaturePolicyContent, csrf: string) => post<{ policy: FeaturePolicyContent }>("/api/admin/policy/validate", policy, csrf),
  publish: (input: PublishFeaturePolicyInput, csrf: string) => post<FeaturePolicyAuditEntry>("/api/admin/policy/publish", input, csrf),
  history: (input: { limit?: number; beforeRevision?: number } = {}) => {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.beforeRevision !== undefined) query.set("beforeRevision", String(input.beforeRevision));
    const suffix = query.size ? `?${query}` : "";
    return adminRequest<AdminHistoryPage>(`/api/admin/policy/history${suffix}`);
  },
  revision: (revision: number) => adminRequest<FeaturePolicyAuditEntry>(`/api/admin/policy/history/${revision}`),
  rollback: (input: RollbackFeaturePolicyInput, csrf: string) => post<FeaturePolicyAuditEntry>("/api/admin/policy/rollback", input, csrf),
  oauthStartUrl: (provider: "github" | "discord", returnPath = "/admin") => `${API_BASE_URL}/api/admin/oauth/${provider}/start?${new URLSearchParams({ returnPath })}`,
  events: async (signal: AbortSignal, lastRevision?: number) => {
    const response = await fetch(`${API_BASE_URL}/api/admin/policy/events`, {
      credentials: "include",
      signal,
      headers: {
        Accept: "text/event-stream",
        ...(lastRevision === undefined ? {} : { "Last-Event-ID": String(lastRevision) }),
      },
    });
    if (!response.ok) throw await failedAdminResponse(response);
    return response;
  },
};
