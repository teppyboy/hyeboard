import { HyeboardError, type EncryptedSessionPayload } from "@hyeboard/core";
import { BROWSER_USER_AGENT } from "../http";
import type { CanvasAssignment, CanvasDashboardCard, CanvasPlannerItem } from "./types";

const CANVAS_BASE = "https://portal.uet.vnu.edu.vn";

export class CanvasClient {
  constructor(private readonly session?: EncryptedSessionPayload) {}

  private headers(): HeadersInit {
    const credential = this.session?.canvas;
    const headers: Record<string, string> = { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", "User-Agent": BROWSER_USER_AGENT };
    if (credential?.kind === "bearer") headers.Authorization = `Bearer ${credential.value}`;
    if (credential?.kind === "cookie") headers.Cookie = credential.value;
    if (credential?.csrfToken) headers["X-CSRF-Token"] = credential.csrfToken;
    return headers;
  }

  private async request<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${CANVAS_BASE}${path}`, { headers: this.headers() });
    } catch {
      throw new HyeboardError("CANVAS_REQUEST_FAILED", "Could not reach the learning platform. Try again later.", 502);
    }
    if (!response.ok) throw new HyeboardError("CANVAS_REQUEST_FAILED", `Learning platform request failed: ${response.status}`, response.status);
    try {
      return await response.json() as T;
    } catch {
      throw new HyeboardError("CANVAS_REQUEST_FAILED", "The learning platform returned a non-JSON response.", 502);
    }
  }

  getDashboardCards() { return this.request<CanvasDashboardCard[]>("/api/v1/dashboard/dashboard_cards"); }
  getPlannerItems() { return this.request<CanvasPlannerItem[]>("/api/v1/planner/items?start_date=2025-01-01T00%3A00%3A00Z&filter=all&order=asc"); }
  getMissingSubmissions() { return this.request<CanvasAssignment[]>("/api/v1/users/self/missing_submissions?include%5B%5D=planner_overrides&filter%5B%5D=submittable"); }
  getUnreadConversations() { return this.request<{ unread_count: string | number }>("/api/v1/conversations/unread_count"); }
}
