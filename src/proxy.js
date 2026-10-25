// Stdio MCP proxy: the host talks to us, we talk to the real server.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { decide, afterResult, wrapOutput, toolPin, redact } from "./policy.js";
import { Store } from "./store.js";

export async function runProxy({ command, args, policy, stateDir, tracePath, env }) {
  const store = new Store(stateDir, tracePath);
  const upstream = new Client({ name: "mcp-leash", version: "0.1.0" });
  await upstream.connect(new StdioClientTransport({ command, args, env: { ...process.env, ...env }, stderr: "inherit" }));

  const state = { tainted: false, pinChanged: new Set(), approvals: new Set() };
  const tools = new Map();

  async function refreshTools() {
    const listed = await upstream.listTools();
    const pins = store.readPins();
    const changed = [];
    for (const t of listed.tools) {
      tools.set(t.name, t);
      const pin = toolPin(t);
      if (!pins[t.name]) pins[t.name] = pin;
      else if (pins[t.name] !== pin) { state.pinChanged.add(t.name); changed.push(t.name); }
    }
    store.writePins(pins);
    store.trace({ event: "tools_listed", count: listed.tools.length, pin_changed: changed });
    return listed;
  }

  const server = new Server({ name: "mcp-leash", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const listed = await refreshTools();
    return { tools: listed.tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: callArgs = {} } = req.params;
    if (!tools.size) await refreshTools();
    const tool = tools.get(name) ?? { name };
    for (const key of store.approvedKeys()) state.approvals.add(key);
    let d = decide(state, tool, callArgs, policy);
    let approvedVia = null;

    if (d.decision === "approve") {
      approvedVia = await askHost(server, d, name, callArgs);
      if (approvedVia) {
        state.approvals.add(d.key);
        d = decide(state, tool, callArgs, policy);
      } else {
        store.addPending(d.key, { tool: name, args: redact(callArgs), reason: d.reason });
      }
    }

    const entry = {
      event: "call", tool: { name, description: tool.description ?? "", annotations: tool.annotations ?? {} },
      key: d.key, kind: d.kind, args: redact(callArgs), decision: d.decision, reason: d.reason,
      tainted_by: state.tainted ? state.tainted.by : null, approved_via: approvedVia,
    };

    if (d.decision !== "allow") {
      store.trace({ ...entry, executed: false });
      const help = d.decision === "approve"
        ? `\nTo allow this exact call once, the user runs:  mcp-leash approve ${d.key}   (or: npx github:cero753/mcp-leash approve ${d.key})\nThen retry the same call. Do not try to work around this hold.`
        : "";
      return { isError: true, content: [{ type: "text", text: `mcp-leash ${d.decision === "approve" ? "held" : "blocked"} "${name}" (id ${d.key}): ${d.reason}.${help}` }] };
    }

    // Approvals are single use: one approval allows one execution of this exact call.
    if (state.approvals.has(d.key)) { state.approvals.delete(d.key); store.consume(d.key); }
    const result = await upstream.callTool({ name, arguments: callArgs });
    const chars = (result.content ?? []).reduce((n, c) => n + (c.type === "text" ? c.text.length : 0), 0);
    store.trace({ ...entry, executed: true, is_error: !!result.isError, result_chars: chars });
    afterResult(state, name, policy);
    const content = (result.content ?? []).map((c) => (c.type === "text" ? { ...c, text: wrapOutput(name, c.text, policy) } : c));
    return { ...result, content };
  });

  await server.connect(new StdioServerTransport());
  const shutdown = async () => { try { await upstream.close(); } finally { process.exit(0); } };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Ask the person through MCP elicitation when the host supports it.
// Returns "elicitation" on approval, "file" if a file approval exists, else null.
async function askHost(server, d, name, args) {
  const caps = server.getClientCapabilities?.() ?? {};
  if (!caps.elicitation) return null;
  try {
    const res = await server.elicitInput({
      message: `mcp-leash: approve "${name}"?\n${d.reason}\nArguments: ${JSON.stringify(redact(args)).slice(0, 500)}`,
      requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Approve this call once" } }, required: ["approve"] },
    });
    return res.action === "accept" && res.content?.approve === true ? "elicitation" : null;
  } catch {
    return null;
  }
}
