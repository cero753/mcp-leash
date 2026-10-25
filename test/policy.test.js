import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, decide, afterResult, mergePolicy, wrapOutput, redact, toolPin } from "../src/policy.js";
import { replay } from "../src/replay.js";

const P = mergePolicy();
const fresh = () => ({ tainted: false, pinChanged: new Set(), approvals: new Set() });

test("classifies reads and writes from annotations, tags and verbs", () => {
  assert.equal(classify({ name: "list_messages" }).kind, "read");
  assert.equal(classify({ name: "getUser" }).kind, "read");
  assert.equal(classify({ name: "archive_channel" }).kind, "write");
  assert.equal(classify({ name: "admin_apps_approve" }).kind, "write");
  assert.equal(classify({ name: "x", description: "[UNVERIFIED WRITE] Approve an app" }).kind, "write");
  assert.equal(classify({ name: "delete_all", annotations: { readOnlyHint: true } }).kind, "read");
  assert.equal(classify({ name: "list", annotations: { destructiveHint: true } }).kind, "write");
  assert.equal(classify({ name: "frobnicate" }).kind, "write", "unknown verbs fail closed");
  assert.equal(classify({ name: "frobnicate" }, mergePolicy({ readTools: ["frobnicate"] })).kind, "read");
});

test("reads always pass; writes need approval; taint escalates even allowed writes", () => {
  const s = fresh();
  assert.equal(decide(s, { name: "list_messages" }, {}, P).decision, "allow");
  assert.equal(decide(s, { name: "archive_channel" }, { channel: "g" }, P).decision, "approve");
  const lax = mergePolicy({ writes: "allow" });
  assert.equal(decide(s, { name: "archive_channel" }, {}, lax).decision, "allow");
  afterResult(s, "list_messages", lax);
  const d = decide(s, { name: "archive_channel" }, {}, lax);
  assert.equal(d.decision, "approve");
  assert.match(d.reason, /after untrusted output from "list_messages"/);
  assert.equal(decide(s, { name: "archive_channel" }, {}, mergePolicy({ writes: "allow", taintedWrites: "deny" })).decision, "deny");
});

test("an approval covers only the exact call it was given for", () => {
  const s = fresh();
  afterResult(s, "read_messages", P);
  const held = decide(s, { name: "archive_channel" }, { channel: "general" }, P);
  s.approvals.add(held.key);
  assert.equal(decide(s, { name: "archive_channel" }, { channel: "general" }, P).decision, "allow");
  assert.equal(decide(s, { name: "archive_channel" }, { channel: "random" }, P).decision, "approve");
});

test("a changed tool is denied, and pins ignore key order", () => {
  const s = fresh();
  s.pinChanged.add("archive_channel");
  assert.equal(decide(s, { name: "archive_channel" }, {}, P).decision, "deny");
  assert.equal(toolPin({ name: "a", inputSchema: { x: 1, y: 2 } }), toolPin({ name: "a", inputSchema: { y: 2, x: 1 } }));
  assert.notEqual(toolPin({ name: "a", description: "one" }), toolPin({ name: "a", description: "two" }));
});

test("output is wrapped and capped; secrets are redacted in traces", () => {
  const w = wrapOutput("t", "x".repeat(50), mergePolicy({ maxOutputChars: 10 }));
  assert.match(w, /<untrusted-tool-output tool="t" \(truncated from 50 chars\)>/);
  assert.deepEqual(redact({ channel: "g", api_key: "k", nested: { Authorization: "b" } }), { channel: "g", api_key: "[redacted]", nested: { Authorization: "[redacted]" } });
});

test("replay flags a policy that would have let a held write through", () => {
  const trace = [
    { event: "call", session: "a", _line: 1, tool: { name: "read_messages" }, key: "k1", decision: "allow", reason: "read", executed: true },
    { event: "call", session: "a", _line: 2, tool: { name: "archive_channel" }, key: "k2", decision: "approve", reason: "held", executed: false },
  ];
  assert.deepEqual(replay(trace, P).map((r) => r.change), ["same", "same"]);
  const loose = replay(trace, mergePolicy({ writes: "allow", untrustedOutputs: [] }));
  assert.equal(loose[1].change, "loosened");
});

test("taint does not leak across sessions on replay", () => {
  const trace = [
    { event: "call", session: "a", _line: 1, tool: { name: "read_messages" }, key: "k1", decision: "allow", reason: "read", executed: true },
    { event: "call", session: "b", _line: 2, tool: { name: "archive_channel" }, key: "k2", decision: "allow", reason: "clean", executed: true },
  ];
  assert.equal(replay(trace, mergePolicy({ writes: "allow" }))[1].after, "allow");
});
