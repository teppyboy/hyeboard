// HTTP client for daotao.vnu.edu.vn (classic ASP portal, cookie-session auth,
// server-rendered HTML — no JSON API). See har-notes.md for the research this
// is based on. Unlike StudentHubClient (bearer/cookie against a JSON API),
// this client authenticates with a real username+password POST and every
// subsequent call is an authenticated HTML page fetch parsed by parser.ts.

import { HyeboardError, type EncryptedSessionPayload } from "@hyeboard/core";
import { BROWSER_USER_AGENT } from "../http";
import { isDaotaoSessionExpired, isPointDetailPageHtml } from "./parser";

const BASE = "https://daotao.vnu.edu.vn";

export class DaotaoClient {
  private cookies: string;

  constructor(private readonly session?: EncryptedSessionPayload) {
    this.cookies = this.session?.vnu?.value ?? "";
  }

  private mergeSetCookies(response: Response): void {
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
    for (const entry of setCookies) {
      const [nameValue] = entry.split(";");
      const [name] = nameValue.split("=");
      if (!name) continue;
      const cookieName = name.trim() + "=";
      const idx = this.cookies.indexOf(cookieName);
      if (idx >= 0) {
        const end = this.cookies.indexOf(";", idx);
        this.cookies = this.cookies.slice(0, idx) + nameValue.trim() + (end >= 0 ? this.cookies.slice(end) : "");
      } else {
        this.cookies = this.cookies ? `${this.cookies}; ${nameValue.trim()}` : nameValue.trim();
      }
    }
  }

  private async fetchPage(path: string, signal?: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${BASE}${path}`, {
        redirect: "follow",
        signal,
        headers: { "User-Agent": BROWSER_USER_AGENT, ...(this.cookies ? { Cookie: this.cookies } : {}) },
      });
    } catch {
      if (signal?.aborted) throw signal.reason ?? new DOMException("This operation was aborted", "AbortError");
      throw new HyeboardError("VNU_UPSTREAM_UNAVAILABLE", "Could not reach daotao.vnu.edu.vn. The portal may be down or your network may be blocking it.", 502);
    }
    this.mergeSetCookies(response);
    if (response.status === 429) throw new HyeboardError("VNU_RATE_LIMITED", "daotao.vnu.edu.vn is rate-limiting requests. Wait a few minutes and try again.", 429);
    if (response.status >= 500) throw new HyeboardError("VNU_UPSTREAM_UNAVAILABLE", `daotao.vnu.edu.vn returned ${response.status}. Try again later.`, 502);
    if (!response.ok) throw new HyeboardError("VNU_REQUEST_FAILED", `daotao.vnu.edu.vn rejected the request with HTTP ${response.status}.`, response.status);
    let html: string;
    try {
      html = await response.text();
    } catch {
      if (signal?.aborted) throw signal.reason ?? new DOMException("This operation was aborted", "AbortError");
      throw new HyeboardError("VNU_UPSTREAM_UNAVAILABLE", "Could not read the response from daotao.vnu.edu.vn. The portal connection may have been interrupted.", 502);
    }
    if (isDaotaoSessionExpired(response.url, html)) {
      throw new HyeboardError("VNU_SESSION_EXPIRED", "The university portal session has expired. Sign in again.", 401);
    }
    return html;
  }

  // POSTs credentials to the real login endpoint and returns the combined
  // Cookie header string from Set-Cookie. Uses redirect: "manual" because the
  // login response is a redirect, and Set-Cookie headers from an
  // intermediate redirect hop aren't reliably exposed once fetch follows it.
  async login(username: string, password: string, signal?: AbortSignal): Promise<string> {
    const body = new URLSearchParams({ txtLoginId: username, txtPassword: password, chkSubmit: "ok" });
    let response: Response;
    try {
      response = await fetch(`${BASE}/dkmh/login.asp`, {
        method: "POST",
        redirect: "manual",
        signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": BROWSER_USER_AGENT },
        body: body.toString(),
      });
    } catch {
      if (signal?.aborted) throw signal.reason ?? new DOMException("This operation was aborted", "AbortError");
      throw new HyeboardError("VNU_UPSTREAM_UNAVAILABLE", "Could not reach daotao.vnu.edu.vn. The portal may be down or your network may be blocking it.", 502);
    }
    if (response.status === 429) throw new HyeboardError("VNU_RATE_LIMITED", "daotao.vnu.edu.vn is rate-limiting login attempts. Wait a few minutes before trying again.", 429);
    if (response.status >= 500) throw new HyeboardError("VNU_UPSTREAM_UNAVAILABLE", `daotao.vnu.edu.vn returned ${response.status} during login. Try again later.`, 502);
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
    if (!setCookies.length) throw new HyeboardError("INVALID_VNU_CREDENTIAL", "daotao.vnu.edu.vn did not accept this username and password. Check both fields and try again.", 401);
    return setCookies.map((entry) => entry.split(";")[0]).join("; ");
  }

  getProfileHtml(signal?: AbortSignal) { return this.fetchPage("/StdInfo/TabStdSelf.asp", signal); }

  // Lightweight session validation — fetches a minimal page to confirm the
  // daotao cookie is still accepted. Throws VNU_SESSION_EXPIRED if the cookie
  // is rejected, confirming freshness otherwise. ~8 KB; cheaper than any
  // data-bearing page.
  validateSession(signal?: AbortSignal) { return this.fetchPage("/dkmh/login.asp", signal); }
  getGradesHtml(signal?: AbortSignal) { return this.fetchPage("/ListPoint/listpoint_Brc1.asp", signal); }
  getStudyProgressHtml(signal?: AbortSignal) { return this.fetchPage("/StdInfo/TabStdStudy.asp", signal); }
  getExamBaseHtml(signal?: AbortSignal) { return this.fetchPage("/StdExamination/StdExamination.asp?selViewType=StdExam", signal); }
  getSyllabusHtml(signal?: AbortSignal) { return this.fetchPage("/SiteManager/Syllabus/default.asp", signal); }

  getExamsHtml(params: { selUniv: string; selStd: string; vTermID: string }, signal?: AbortSignal): Promise<string> {
    const query = new URLSearchParams({ selViewType: "StdExam", selBK: "0", selTG: "0", ...params });
    return this.fetchPage(`/StdExamination/StdExamination.asp?${query.toString()}`, signal);
  }

  // ListPoint/listpoint_Brc1.asp?selStd=... — transcript page for a GIVEN
  // student. Unlike StdExamination.asp (which silently ignores selStd — see
  // har-notes.md), this endpoint HONORS selStd (live-verified): it renders
  // that student's identity header and full transcript. It is the only
  // verified student-role StdID -> identity oracle, and is only ever called
  // from the gated cross-lookup worker routes. The stdId is zero-padded to
  // the portal's 11-digit id shape here, server-side, so callers pass the
  // plain numeric id.
  getTranscriptByStdIdHtml(stdId: string, signal?: AbortSignal): Promise<string> {
    const query = new URLSearchParams({ selStd: stdId.padStart(11, "0") });
    return this.fetchPage(`/ListPoint/listpoint_Brc1.asp?${query.toString()}`, signal);
  }

  // ListPoint/detailPoint.asp — per-component grade breakdown popup. The
  // stdId here must come from the authenticated grades row (server-side),
  // never from a client query param; val is a cosmetic echo the portal
  // renders into the footer without validating it (see har-notes.md).
  async getPointDetailHtml(params: { id: string; stdId: string; term: string; val?: string }, signal?: AbortSignal): Promise<string> {
    const query = new URLSearchParams({
      id: params.id,
      val: params.val ?? "",
      StdID: params.stdId.padStart(11, "0"),
      Term: params.term,
    });
    const html = await this.fetchPage(`/ListPoint/detailPoint.asp?${query.toString()}`, signal);
    if (!isPointDetailPageHtml(html)) {
      throw new HyeboardError(
        "VNU_UPSTREAM_RESPONSE_INVALID",
        "daotao.vnu.edu.vn returned an unexpected point-detail page.",
        502,
      );
    }
    return html;
  }
}
