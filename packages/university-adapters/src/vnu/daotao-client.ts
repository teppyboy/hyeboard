// HTTP client for daotao.vnu.edu.vn (classic ASP portal, cookie-session auth,
// server-rendered HTML — no JSON API). See har-notes.md for the research this
// is based on. Unlike StudentHubClient (bearer/cookie against a JSON API),
// this client authenticates with a real username+password POST and every
// subsequent call is an authenticated HTML page fetch parsed by parser.ts.

import { HyeboardError, type EncryptedSessionPayload } from "@hyeboard/core";
import { BROWSER_USER_AGENT } from "../http";
import { hasLoginForm } from "./parser";

const BASE = "https://daotao.vnu.edu.vn";

export class DaotaoClient {
  constructor(private readonly session?: EncryptedSessionPayload) {}

  private cookie(): string | undefined {
    return this.session?.vnu?.value;
  }

  private async fetchPage(path: string): Promise<string> {
    const cookie = this.cookie();
    let response: Response;
    try {
      response = await fetch(`${BASE}${path}`, {
        redirect: "follow",
        headers: { "User-Agent": BROWSER_USER_AGENT, ...(cookie ? { Cookie: cookie } : {}) },
      });
    } catch {
      throw new HyeboardError("VNU_UPSTREAM_UNAVAILABLE", "Could not reach daotao.vnu.edu.vn. The portal may be down or your network may be blocking it.", 502);
    }
    if (response.status === 429) throw new HyeboardError("VNU_RATE_LIMITED", "daotao.vnu.edu.vn is rate-limiting requests. Wait a few minutes and try again.", 429);
    if (response.status >= 500) throw new HyeboardError("VNU_UPSTREAM_UNAVAILABLE", `daotao.vnu.edu.vn returned ${response.status}. Try again later.`, 502);
    if (!response.ok) throw new HyeboardError("VNU_REQUEST_FAILED", `daotao.vnu.edu.vn rejected the request with HTTP ${response.status}.`, response.status);
    const html = await response.text();
    // The ASP portal doesn't return 401s for an expired/invalid session — it
    // just re-renders the login page. Detect that explicitly so callers get
    // a real "sign in again" error instead of silently parsing an empty page.
    if (hasLoginForm(html)) throw new HyeboardError("VNU_SESSION_EXPIRED", "The university portal session has expired. Sign in again.", 401);
    return html;
  }

  // POSTs credentials to the real login endpoint and returns the combined
  // Cookie header string from Set-Cookie. Uses redirect: "manual" because the
  // login response is a redirect, and Set-Cookie headers from an
  // intermediate redirect hop aren't reliably exposed once fetch follows it.
  async login(username: string, password: string): Promise<string> {
    const body = new URLSearchParams({ txtLoginId: username, txtPassword: password, chkSubmit: "ok" });
    let response: Response;
    try {
      response = await fetch(`${BASE}/dkmh/login.asp`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": BROWSER_USER_AGENT },
        body: body.toString(),
      });
    } catch {
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

  getProfileHtml() { return this.fetchPage("/StdInfo/TabStdSelf.asp"); }
  getGradesHtml() { return this.fetchPage("/ListPoint/listpoint_Brc1.asp"); }
  getStudyProgressHtml() { return this.fetchPage("/StdInfo/TabStdStudy.asp"); }
  getExamBaseHtml() { return this.fetchPage("/StdExamination/StdExamination.asp?selViewType=StdExam"); }
  getSyllabusHtml() { return this.fetchPage("/SiteManager/Syllabus/default.asp"); }

  getExamsHtml(params: { selUniv: string; selStd: string; vTermID: string }): Promise<string> {
    const query = new URLSearchParams({ selViewType: "StdExam", selBK: "0", selTG: "0", ...params });
    return this.fetchPage(`/StdExamination/StdExamination.asp?${query.toString()}`);
  }
}
