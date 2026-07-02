// HTTP client for daotao.vnu.edu.vn (classic ASP portal, cookie-session auth,
// server-rendered HTML — no JSON API). See har-notes.md for the research this
// is based on. Unlike StudentHubClient (bearer/cookie against a JSON API),
// this client authenticates with a real username+password POST and every
// subsequent call is an authenticated HTML page fetch parsed by parser.ts.

import { HyeboardError, type EncryptedSessionPayload } from "@hyeboard/core";
import { hasLoginForm } from "./parser";

const BASE = "https://daotao.vnu.edu.vn";

export class DaotaoClient {
  constructor(private readonly session?: EncryptedSessionPayload) {}

  private cookie(): string | undefined {
    return this.session?.vnu?.value;
  }

  private async fetchPage(path: string): Promise<string> {
    const cookie = this.cookie();
    const response = await fetch(`${BASE}${path}`, {
      redirect: "follow",
      headers: cookie ? { Cookie: cookie } : {},
    });
    if (!response.ok) throw new HyeboardError("VNU_REQUEST_FAILED", `University portal request failed: ${response.status}`, response.status);
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
    const response = await fetch(`${BASE}/dkmh/login.asp`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
    if (!setCookies.length) throw new HyeboardError("INVALID_VNU_CREDENTIAL", "The university portal rejected this username or password.", 401);
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
