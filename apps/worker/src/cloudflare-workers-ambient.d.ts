// Minimal ambient shim for "cloudflare:workers" so that index.ts's dynamic
// `import("cloudflare:workers")` typechecks under tsconfig.node.json (Node/Bun
// types only, no @cloudflare/workers-types). This branch never actually
// executes under Node/Bun (see the runtime-detection guard in index.ts), so
// the loose `any` shape here is fine — it exists purely to satisfy `tsc`,
// not to describe real runtime behavior. tsconfig.json (the real Cloudflare
// Workers build) uses @cloudflare/workers-types' own accurate declaration
// for this module instead; this file is not included there.
declare module "cloudflare:workers" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const env: any;
}
