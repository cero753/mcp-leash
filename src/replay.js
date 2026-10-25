// Re-run recorded calls through a (possibly new) policy without touching any server.
import { decide, afterResult } from "./policy.js";

const STRICTNESS = { allow: 0, approve: 1, deny: 2 };

export function replay(entries, policy) {
  let state = null;
  let session;
  const rows = [];
  for (const e of entries) {
    // Each proxy process is one host session; taint and pin state start fresh with it.
    if (!state || e.session !== session) { state = { tainted: false, pinChanged: new Set(), approvals: new Set() }; session = e.session; }
    if (e.event === "tools_listed") { for (const n of e.pin_changed ?? []) state.pinChanged.add(n); continue; }
    if (e.event !== "call") continue;
    // A human approval recorded in the trace still counts as an approval on replay.
    if (e.approved_via || /approved by a human/.test(e.reason ?? "")) state.approvals.add(e.key);
    const now = decide(state, e.tool, null, policy, e.key);
    state.approvals.delete(e.key);
    const change = STRICTNESS[now.decision] - STRICTNESS[e.decision];
    rows.push({ line: e._line, tool: e.tool.name, before: e.decision, after: now.decision, reason: now.reason,
      change: change < 0 ? "loosened" : change > 0 ? "tightened" : "same" });
    // Taint follows what really executed in the recorded session.
    if (e.executed) afterResult(state, e.tool.name, policy);
  }
  return rows;
}

export function formatReplay(rows) {
  const lines = rows.map((r) => `line ${String(r.line).padStart(3)}  ${r.tool.padEnd(28)} ${r.before.padEnd(8)} -> ${r.after.padEnd(8)} ${r.change === "same" ? "" : r.change.toUpperCase()}`);
  const loosened = rows.filter((r) => r.change === "loosened").length;
  const tightened = rows.filter((r) => r.change === "tightened").length;
  lines.push("", `${rows.length} calls replayed: ${loosened} loosened, ${tightened} tightened, ${rows.length - loosened - tightened} unchanged.`);
  return { text: lines.join("\n"), loosened, tightened };
}
