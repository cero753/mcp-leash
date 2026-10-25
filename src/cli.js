#!/usr/bin/env node
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mergePolicy } from "./policy.js";
import { Store, readTrace } from "./store.js";
import { replay, formatReplay } from "./replay.js";
import { toChatNoir } from "./export.js";

const USAGE = `mcp-leash: a runtime guard between an MCP host and an MCP server

  mcp-leash [--policy leash.json] [--state DIR] [--trace FILE] -- <server command> [args...]
  mcp-leash pending              list held calls waiting for approval
  mcp-leash approve <id>         allow one held call once
  mcp-leash repin                accept current tool descriptions after review
  mcp-leash replay <trace> [--policy leash.json]   re-decide a recorded session; exit 1 if anything loosened
  mcp-leash export --chatnoir <trace> [-o report.json]

State defaults to ~/.mcp-leash (override with --state or MCP_LEASH_STATE).`;

function parse(argv) {
  const sep = argv.indexOf("--");
  const head = sep === -1 ? argv : argv.slice(0, sep);
  const opts = { _: [], server: sep === -1 ? [] : argv.slice(sep + 1) };
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (a === "--policy") opts.policy = head[++i];
    else if (a === "--state") opts.state = head[++i];
    else if (a === "--trace") opts.trace = head[++i];
    else if (a === "-o" || a === "--out") opts.out = head[++i];
    else if (a === "--chatnoir") opts.chatnoir = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else opts._.push(a);
  }
  return opts;
}

function loadPolicy(path) {
  return mergePolicy(path ? JSON.parse(readFileSync(path, "utf8")) : {});
}

async function main() {
  const o = parse(process.argv.slice(2));
  const stateDir = resolve(o.state ?? process.env.MCP_LEASH_STATE ?? join(homedir(), ".mcp-leash"));
  const [cmd, arg] = o._;
  if (o.help || (!cmd && !o.server.length)) { console.log(USAGE); return 0; }

  if (o.server.length && !cmd) {
    const { runProxy } = await import("./proxy.js");
    await runProxy({ command: o.server[0], args: o.server.slice(1), policy: loadPolicy(o.policy), stateDir, tracePath: o.trace ? resolve(o.trace) : undefined });
    return null; // keep running
  }
  const store = new Store(stateDir);
  if (cmd === "pending") {
    const rows = Object.entries(store.approvals()).filter(([, v]) => v.status === "pending");
    if (!rows.length) console.log("No held calls.");
    for (const [k, v] of rows) console.log(`${k}  ${v.tool}  ${JSON.stringify(v.args).slice(0, 120)}\n      ${v.reason}`);
    return 0;
  }
  if (cmd === "approve") {
    if (!arg) { console.error("usage: mcp-leash approve <id>"); return 2; }
    if (!store.approve(arg)) { console.error(`No held call with id ${arg}. Run mcp-leash pending.`); return 2; }
    console.log(`Approved ${arg} once. Ask the agent to retry the same call.`);
    return 0;
  }
  if (cmd === "repin") { rmSync(store.file("pins.json"), { force: true }); console.log("Pins cleared. Current tool descriptions will be pinned on next listing."); return 0; }
  if (cmd === "replay") {
    if (!arg) { console.error("usage: mcp-leash replay <trace>"); return 2; }
    const { text, loosened } = formatReplay(replay(readTrace(arg), loadPolicy(o.policy)));
    console.log(text);
    return loosened ? 1 : 0;
  }
  if (cmd === "export" && o.chatnoir) {
    if (!arg) { console.error("usage: mcp-leash export --chatnoir <trace>"); return 2; }
    const report = JSON.stringify(toChatNoir(readTrace(arg), resolve(arg)), null, 2) + "\n";
    if (o.out) writeFileSync(o.out, report, { flag: "wx" }); else process.stdout.write(report);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

main().then((code) => { if (code !== null) process.exit(code); }, (e) => { console.error(`mcp-leash: ${e.message}`); process.exit(2); });
