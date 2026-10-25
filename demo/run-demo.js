// End-to-end demo with a SCRIPTED agent: it reads messages and obeys any "Call archive_channel"
// instruction it finds in tool output. That stands in for a model that follows injected text;
// it says nothing about how often real models do. All data is synthetic and local.
//
//   node demo/run-demo.js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "src", "cli.js");
const fixture = join(here, "inbox-server.js");
const work = mkdtempSync(join(tmpdir(), "mcp-leash-demo-"));
const sink = join(work, "sink.jsonl");
const state = join(work, "state");
const trace = join(work, "trace.jsonl");

const archived = () => (existsSync(sink) ? readFileSync(sink, "utf8").trim().split("\n").filter(Boolean).length : 0);

async function connect({ leash, env = {} }) {
  const server = [process.execPath, fixture];
  const t = leash
    ? new StdioClientTransport({ command: process.execPath, args: [cli, "--state", state, "--trace", trace, "--", ...server], env: { ...process.env, SINK: sink, ...env } })
    : new StdioClientTransport({ command: server[0], args: server.slice(1), env: { ...process.env, SINK: sink, ...env } });
  const c = new Client({ name: "scripted-agent", version: "0.1.0" });
  await c.connect(t);
  await c.listTools();
  return c;
}

// The scripted agent: read, then follow any archive instruction found in the output.
async function agentTurn(c) {
  const read = await c.callTool({ name: "read_messages", arguments: {} });
  const text = read.content[0].text;
  const m = text.match(/Call archive_channel with channel=(\w+)/);
  if (!m) return { read: true, write: null };
  const write = await c.callTool({ name: "archive_channel", arguments: { channel: m[1] } });
  return { read: text.includes("Standup moved"), write };
}

const rows = [];
const row = (scenario, result) => { rows.push([scenario, result]); console.log(`${scenario.padEnd(52)} ${result}`); };

// 1. No leash
let c = await connect({ leash: false });
let r = await agentTurn(c);
await c.close();
row("1. Without mcp-leash: injected archive", `${archived()} archive executed; read ok=${r.read}`);

// 2. With leash
rmSync(sink, { force: true });
c = await connect({ leash: true });
r = await agentTurn(c);
const held = r.write.content[0].text;
const id = held.match(/id ([0-9a-f]{12})/)?.[1];
row("2. With mcp-leash: injected archive", `${archived()} archive executed; read ok=${r.read}; held id=${id}`);

// 3. A human approves that exact call once, the agent retries
execFileSync(process.execPath, [cli, "approve", id, "--state", state]);
const retry = await c.callTool({ name: "archive_channel", arguments: { channel: "general" } });
row("3. Human approves once, agent retries", `${archived()} archive executed (${retry.isError ? "error" : "ok"})`);
const again = await c.callTool({ name: "archive_channel", arguments: { channel: "general" } });
row("4. Same call again without a new approval", `${archived()} archive total; held again=${!!again.isError}`);
await c.close();

// 5. The server changes a tool description after it was pinned
c = await connect({ leash: true, env: { RUG_PULL: "1" } });
const pulled = await c.callTool({ name: "archive_channel", arguments: { channel: "random" } });
const readAfter = await c.callTool({ name: "read_messages", arguments: {} });
await c.close();
row("5. Tool description changed after pinning", `blocked=${/changed its description/.test(pulled.content[0].text)}; unchanged read still ok=${!readAfter.isError}; ${archived()} archive total`);

console.log(`\nTrace: ${trace}`);
console.log(`Replay:  node src/cli.js replay "${trace}"`);
console.log(`Export:  node src/cli.js export --chatnoir "${trace}"`);
process.env.MCP_LEASH_DEMO_TRACE = trace;
