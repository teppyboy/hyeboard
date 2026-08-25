import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertPackagedConfig, createPackagedConfig } from "./package.mjs";

const workerConfig = JSON.parse(await readFile(new URL("../apps/worker/config.json", import.meta.url), "utf8"));

test("packaged config includes current VNU, HA, and non-secret admin settings without secrets or deployment URLs", () => {
  const config = assertPackagedConfig(createPackagedConfig(workerConfig));

  assert.deepEqual(config.vnu, workerConfig.vnu);
  assert.deepEqual(config.ha, workerConfig.ha);
  assert.deepEqual(config.admin, workerConfig.admin);
  assert.deepEqual(config.origins, []);
  assert.equal(config.browser.ws_endpoint, "");
  assert.equal(config.admin.public_origin, "");
  assert.equal(config.static_dir, "./public");
  assert.doesNotMatch(JSON.stringify(config), /HYEB_(?:SESSION|ADMIN_SESSION)_SECRET|DATABASE_URL|REDIS_URL|POSTGRES_URL|password_hash|client_secret|token|cookie/i);
});
