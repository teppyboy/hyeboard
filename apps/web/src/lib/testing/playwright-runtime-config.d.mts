export type PlaywrightRuntimeConfig = Readonly<{
  host: string;
  vitePort: number;
  workerPort: number;
  workers: number;
  baseUrl: string;
  proxyTarget: string;
}>;

export function parsePlaywrightRuntimeConfig(environment?: Record<string, string | undefined>): PlaywrightRuntimeConfig;
export const playwrightRuntimeConfig: PlaywrightRuntimeConfig;
