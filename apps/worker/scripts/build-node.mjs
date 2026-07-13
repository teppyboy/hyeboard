import { rolldown } from "rolldown";

// index.node.ts (not index.ts) — the Node/Bun-only entry point that
// additionally wires up the optional Patchright browser launcher. See
// that file's doc comment for why the split exists.
const bundle = await rolldown({
  input: "src/index.node.ts",
  platform: "node",
  external: [
    "cloudflare:workers",
    "elysia/adapter/cloudflare-worker",
    "@elysiajs/node",
    "elysia/adapter/bun",
    // Only ever dynamically imported in the Node-only startup path; keep it
    // out of the bundle entirely so it's resolved from node_modules only
    // when that branch actually runs (never in production/Bun).
    "pino-pretty",
    // Optional (HYEB_BROWSER_PATCHRIGHT=true) and large — kept out of the
    // self-hosted bundle so deployments that don't use it aren't paying
    // for its size. Resolved from node_modules at runtime via
    // @hyeboard/university-adapters' own dependency on patchright.
    //
    // Both the package AND the file that statically imports it must be
    // external: index.node.ts's dynamic import() of the patchright module
    // is only truly lazy at runtime if it's left as an untouched external
    // specifier (verified against this bundler the same way it was
    // verified against esbuild — see build-node's git history/PR for the
    // confirmed-live esbuild failure mode this guards against: without
    // marking both external, the bundler inlines the dynamically imported
    // file's code into the single output chunk, hoisting ITS static
    // `import "patchright"` into a top-level import in dist/index.js —
    // making Node require patchright unconditionally at startup, breaking
    // any deployment that hasn't installed it).
    "patchright",
    "@hyeboard/university-adapters/src/uet/google-login-automation-patchright",
    // Large WASM/language-data dependency. captcha-ocr.ts is bundled, but
    // imports this package dynamically only when OCR first runs.
    "tesseract.js",
  ],
});

await bundle.write({
  file: "dist/index.js",
  format: "esm",
  sourcemap: true,
  // No banner here (unlike the old esbuild script): Rolldown automatically
  // injects its own createRequire/__require shim for CJS interop and
  // rewrites bare require(...) call-sites in the bundle to use it — adding
  // our own top-level `import { createRequire } from "module"` on top of
  // that caused a duplicate-lexical-declaration SyntaxError at runtime
  // (confirmed live: Rolldown's own shim already imports createRequire
  // from "node:module" before user code runs).
  // Force a single output file. Rolldown defaults to code-splitting
  // (output.dir + multiple chunks) as soon as it sees a dynamic import()
  // of an external module (index.node.ts's lazy patchright import) —
  // codeSplitting: false keeps the single-file dist/index.js output this
  // packaging pipeline expects, same as esbuild's default (no code
  // splitting unless explicitly configured).
  codeSplitting: false,
});

await bundle.close();
