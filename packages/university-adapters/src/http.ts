// A recent, real desktop Chrome User-Agent — sent on every outbound request
// to StudentHub/Canvas/daotao so the traffic looks like an ordinary browser
// session instead of a bare server-side fetch client (bot-detection, WAF
// rules, or just unusual access-log entries can otherwise flag a client
// with no User-Agent, or Node's default one, as suspicious). Value taken
// from a live browser capture (see har-notes.md) — kept as a plain string
// constant rather than trying to dynamically track "the current" Chrome
// version, since matching real capture data matters more here than always
// being bleeding-edge.
export const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
