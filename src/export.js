// Turn held or blocked calls into a ChatNoir report (chatnoir.report/v1) for its render, SARIF and PDF tools.
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { sha256 } from "./policy.js";

// Matches Python json.dumps(files, sort_keys=True, ensure_ascii=True), which ChatNoir uses for the snapshot digest.
function pyDumps(v) {
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(", ")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${pyStr(k)}: ${pyDumps(v[k])}`).join(", ")}}`;
  return typeof v === "string" ? pyStr(v) : JSON.stringify(v);
}
const BS = String.fromCharCode(92);
function pyStr(s) { return JSON.stringify(s).replace(/[^\x00-\x7f]/g, (c) => BS + "u" + c.charCodeAt(0).toString(16).padStart(4, "0")); }

export function toChatNoir(entries, tracePath, cwd = process.cwd()) {
  const rel = relative(cwd, tracePath).split(sep).join("/");
  const bytes = readFileSync(tracePath);
  const files = [{ path: rel, sha256: sha256(bytes), bytes: bytes.length }];
  const findings = [];
  for (const e of entries) {
    if (e.event !== "call" || e.decision === "allow") continue;
    const pin = /changed its description or schema/.test(e.reason);
    const tainted = !!e.tainted_by && !pin;
    const rule = pin ? "LEASH003" : tainted ? "LEASH001" : "LEASH002";
    findings.push({
      id: `leash-L${e._line}`,
      rule_id: rule,
      title: pin ? `Call to re-described tool "${e.tool.name}" blocked`
        : tainted ? `Write "${e.tool.name}" proposed after untrusted output from "${e.tainted_by}"`
        : `Write "${e.tool.name}" held for approval`,
      path: rel,
      line: e._line,
      status: "needs_review",
      severity: pin ? "high" : tainted ? "medium" : "info",
      confidence: "medium",
      evidence: [`Trace line ${e._line}: decision=${e.decision}; ${e.reason}`, `Arguments (secrets redacted): ${JSON.stringify(e.args).slice(0, 300)}`],
      attack_path: tainted ? [`Tool "${e.tainted_by}" returned untrusted content into the session`, `The model then proposed write "${e.tool.name}"`, "mcp-leash held the call before it reached the server"] : [],
      counterevidence: [],
      proof_gaps: [tainted ? "The trace shows ordering only; it does not prove the untrusted content caused the proposal." : "Runtime policy event; source cause not reviewed."],
      validation: { method: "runtime", result: `${e.decision === "approve" ? "Held" : "Blocked"} by mcp-leash before execution; not executed.` },
      remediation: tainted ? "Review the preceding tool output for injected instructions. Keep an approval gate on this write, or authorize it from caller-owned intent rather than tool output."
        : pin ? "Diff the new tool description and schema against the pinned version before re-pinning." : "Approve only if the user intended this write.",
    });
  }
  return {
    format: "chatnoir.report/v1",
    version: "mcp-leash-0.1.0",
    mode: "triage",
    executive_summary: `mcp-leash recorded ${entries.filter((e) => e.event === "call").length} tool calls and held or blocked ${findings.length}. These are runtime events for human review, not confirmed vulnerabilities.`,
    target: { snapshot_sha256: sha256(pyDumps(files)), git_head: null, dirty: null, inventory_strategy: "mcp-leash trace file", files, skipped: [] },
    coverage: { complete: false, reviewed: [rel], deferred: [], limitations: ["Covers only calls that passed through mcp-leash in this trace.", "No source review of the MCP server or host was performed."] },
    findings,
  };
}
