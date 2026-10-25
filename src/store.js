// Small file-backed state: tool pins, approvals and the JSONL trace.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

export class Store {
  constructor(dir, tracePath) {
    this.dir = dir;
    this.tracePath = tracePath ?? join(dir, "trace.jsonl");
    mkdirSync(dir, { recursive: true });
    mkdirSync(dirname(this.tracePath), { recursive: true });
    this.seq = 0;
    this.session = randomBytes(4).toString("hex");
  }
  file(name) { return join(this.dir, name); }
  readJson(name, fallback) {
    try { return JSON.parse(readFileSync(this.file(name), "utf8")); } catch { return fallback; }
  }
  writeJson(name, value) { writeFileSync(this.file(name), JSON.stringify(value, null, 2) + "\n"); }

  readPins() { return this.readJson("pins.json", {}); }
  writePins(p) { this.writeJson("pins.json", p); }

  approvals() { return this.readJson("approvals.json", {}); }
  addPending(key, info) {
    const a = this.approvals();
    if (!a[key] || a[key].status === "used") a[key] = { ...info, status: "pending", requested_at: new Date().toISOString() };
    this.writeJson("approvals.json", a);
  }
  approve(key) {
    const a = this.approvals();
    if (!a[key]) return false;
    a[key].status = "approved";
    a[key].approved_at = new Date().toISOString();
    this.writeJson("approvals.json", a);
    return true;
  }
  approvedKeys() { return Object.entries(this.approvals()).filter(([, v]) => v.status === "approved").map(([k]) => k); }
  consume(key) {
    const a = this.approvals();
    if (a[key]) { a[key].status = "used"; a[key].used_at = new Date().toISOString(); this.writeJson("approvals.json", a); }
  }

  trace(entry) {
    appendFileSync(this.tracePath, JSON.stringify({ ts: new Date().toISOString(), session: this.session, seq: ++this.seq, ...entry }) + "\n");
  }
}

export function readTrace(path) {
  if (!existsSync(path)) throw new Error(`trace not found: ${path}`);
  return readFileSync(path, "utf8").split(/\r?\n/).map((line, i) => ({ line, n: i + 1 })).filter((x) => x.line.trim())
    .map((x) => ({ ...JSON.parse(x.line), _line: x.n }));
}
