import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readTrace } from "../src/store.js";
import { toChatNoir } from "../src/export.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("demo: injected write runs without mcp-leash and is held with it", () => {
  const out = execFileSync(process.execPath, [join(root, "demo", "run-demo.js")], { encoding: "utf8", timeout: 60000 });
  assert.match(out, /1\. Without mcp-leash: injected archive\s+1 archive executed; read ok=true/);
  assert.match(out, /2\. With mcp-leash: injected archive\s+0 archive executed; read ok=true; held id=[0-9a-f]{12}/);
  assert.match(out, /3\. Human approves once, agent retries\s+1 archive executed \(ok\)/);
  assert.match(out, /4\. Same call again without a new approval\s+1 archive total; held again=true/);
  assert.match(out, /5\. Tool description changed after pinning\s+blocked=true; unchanged read still ok=true; 1 archive total/);

  const tracePath = out.match(/Trace: (.+)/)[1].trim();
  const report = toChatNoir(readTrace(tracePath), tracePath, dirname(tracePath));
  assert.equal(report.format, "chatnoir.report/v1");
  assert.equal(report.findings.length, 3);
  assert.deepEqual(report.findings.map((f) => f.rule_id).sort(), ["LEASH001", "LEASH001", "LEASH003"]);

  // If a ChatNoir checkout is available, let its own validator judge the export.
  const chatnoir = process.env.CHATNOIR_PY;
  if (chatnoir) {
    const file = join(dirname(tracePath), "report.json");
    writeFileSync(file, JSON.stringify(report));
    const v = spawnSync("python", [chatnoir, "validate", file], { encoding: "utf8" });
    assert.equal(v.status, 0, v.stderr);
  }
});
