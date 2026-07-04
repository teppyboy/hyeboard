interface Env {
  HYEB_SESSION_SECRET: string;
  HYEB_ALLOWED_ORIGINS?: string;
  BROWSER: Fetcher;
  // Self-hosted (workerd + Docker headless-Chrome) deployments only. When
  // set, google-login-automation connects via puppeteer-core to this plain
  // CDP WebSocket URL instead of using the Cloudflare BROWSER binding.
  HYEB_BROWSER_WS_ENDPOINT?: string;
}
