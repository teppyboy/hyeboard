import { start } from "./start";

// Default entry point — used by wrangler.jsonc's "main" (Cloudflare
// Workers) and by direct `tsx`/`bun` invocation of this file. Deliberately
// tiny and importing nothing beyond ./start: any additional import here
// (even a dynamic one) gets bundled into the Cloudflare Workers deployment
// by wrangler, since Workers has no runtime package resolution and
// wrangler must inline everything reachable from this file regardless of
// import style. See apps/worker/src/index.node.ts for the Node/Bun-only
// entry point that additionally wires up optional, large, Node-only
// dependencies (currently: the Patchright browser automation launcher)
// without ever being reachable from this file's import graph.
export default await start();
