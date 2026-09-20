// The execution queue: a directory of job files, claimed by atomic rename.
//
// Two processes share it and neither trusts the other's memory:
//   - the panel (no private keys) only ever writes a job file
//   - the executor (holds keys) moves a job out of the queue to claim it
//
// Everything here is plain fs work on one directory, so the queue survives a
// restart, can be inspected with `ls`, and a crash cannot leave a job in a
// half-open state: either it is still `queued`, or it sits in `claimed/` with a
// lease that expires.

import fs from "fs";
import path from "path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export type JobStatus = "queued" | "claimed" | "running" | "done" | "failed" | "skipped" | "cancelled";

export interface QueueJob {
  id: string;
  createdAt: string;
  createdBy: "panel";
  status: JobStatus;
  chain: string;
  contract: string;
  slug: string | null;
  name: string | null;
  quantity: number;
  maxPriceEth: string;
  startAtMs: number | null;
  // Audit snapshot taken when the job was created: the executor re-checks the
  // code hash before signing and re-audits if the snapshot is stale, so gate 1
  // is never silently skipped on the automated path.
  auditedAt: string | null;
  grade: string | null;
  quality: number | null;
  codeHash: string | null;
  mintPriceWei: string | null;
  capPerWallet: number | null;
  source: { kind: "row" | "favorite" | "bulk"; note?: string };
  lease: { by: string; expiresAtMs: number } | null;
  attempts: number;
  cancelRequested: boolean;
  cancelledAt: string | null;
  result: {
    status: string;
    txHash: string | null;
    mintedCount: number | null;
    tokenIds?: string[];
    gasBurnedWei?: string;
    ledgerStatus?: string;
    at: string;
  } | null;
  error: string | null;
}

export interface JobInput {
  chain: string;
  contract: string;
  slug?: string | null;
  name?: string | null;
  quantity?: number;
  maxPriceEth?: string;
  startAtMs?: number | null;
  auditedAt?: string | null;
  grade?: string | null;
  quality?: number | null;
  codeHash?: string | null;
  mintPriceWei?: string | null;
  capPerWallet?: number | null;
  source?: { kind: "row" | "favorite" | "bulk"; note?: string };
}

const MAX_QUANTITY = 20;
const MAX_TEXT = 200;

export function validateJobInput(input: JobInput): { ok: boolean; reason?: string } {
  if (!input?.chain || typeof input.chain !== "string") return { ok: false, reason: "chain is required" };
  if (!/^0x[0-9a-f]{40}$/i.test(String(input.contract ?? ""))) return { ok: false, reason: "contract must be a 0x-prefixed 20-byte address" };
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    return { ok: false, reason: `quantity must be an integer between 1 and ${MAX_QUANTITY}` };
  }
  for (const [field, value] of [["slug", input.slug], ["name", input.name]] as const) {
    if (typeof value === "string" && value.length > MAX_TEXT) return { ok: false, reason: `${field} is longer than ${MAX_TEXT} characters` };
  }
  if (input.codeHash != null && !/^0x[0-9a-f]{64}$/i.test(input.codeHash)) return { ok: false, reason: "codeHash must be a 32-byte hash" };
  return { ok: true };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readJson(file: string): QueueJob | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as QueueJob;
  } catch {
    return null;
  }
}

function jobList(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function enqueueJob(dir: string, input: JobInput, nowMs: number): { ok: true; job: QueueJob } | { ok: false; reason: string } {
  const valid = validateJobInput(input);
  if (!valid.ok) return { ok: false, reason: valid.reason! };
  const id = `${new Date(nowMs).toISOString().replace(/[:.]/g, "-")}-${input.contract.toLowerCase().slice(2, 10)}-${randomUUID().slice(0, 8)}`;
  const job: QueueJob = {
    id,
    createdAt: new Date(nowMs).toISOString(),
    createdBy: "panel",
    status: "queued",
    chain: input.chain.toLowerCase(),
    contract: input.contract.toLowerCase(),
    slug: input.slug ?? null,
    name: input.name ?? null,
    quantity: input.quantity ?? 1,
    maxPriceEth: input.maxPriceEth ?? "current",
    startAtMs: input.startAtMs ?? null,
    auditedAt: input.auditedAt ?? null,
    grade: input.grade ?? null,
    quality: input.quality ?? null,
    codeHash: input.codeHash ?? null,
    mintPriceWei: input.mintPriceWei ?? null,
    capPerWallet: input.capPerWallet ?? null,
    source: input.source ?? { kind: "row" },
    lease: null,
    attempts: 0,
    cancelRequested: false,
    cancelledAt: null,
    result: null,
    error: null,
  };
  writeJson(path.join(dir, `${id}.json`), job);
  return { ok: true, job };
}

// Read-only peek for a rehearsal: what would be claimed right now, without
// touching the queue.
export function nextEligible(dir: string, opts: { nowMs: number; claimWindowMs?: number }): QueueJob | null {
  const window = opts.claimWindowMs ?? 2 * 3_600_000;
  return (
    jobList(dir)
      .map(readJson)
      .filter((job): job is QueueJob => job !== null && job.status === "queued" && !job.cancelRequested)
      .filter((job) => job.startAtMs === null || job.startAtMs - opts.nowMs <= window)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null
  );
}

// Claiming is a rename: the OS guarantees exactly one process wins it.
export function claimNext(
  dir: string,
  opts: { by: string; nowMs: number; leaseMs?: number; claimWindowMs?: number }
): { ok: true; job: QueueJob } | { ok: false; reason: string } {
  const leaseMs = opts.leaseMs ?? 5 * 60_000;
  const window = opts.claimWindowMs ?? 2 * 3_600_000;
  const candidates = jobList(dir)
    .map(readJson)
    .filter((job): job is QueueJob => job !== null && job.status === "queued" && !job.cancelRequested)
    .filter((job) => job.startAtMs === null || job.startAtMs - opts.nowMs <= window)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const job of candidates) {
    const claimed = {
      ...job,
      status: "claimed" as JobStatus,
      attempts: job.attempts + 1,
      lease: { by: opts.by, expiresAtMs: opts.nowMs + leaseMs },
    };
    const target = path.join(dir, "claimed", `${job.id}.json`);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(path.join(dir, `${job.id}.json`), target);
    } catch {
      continue; // another claimer won this one
    }
    writeJson(target, claimed);
    return { ok: true, job: claimed };
  }
  return { ok: false, reason: "no eligible job" };
}

function moveToDone(dir: string, job: QueueJob, update: Partial<QueueJob>): void {
  const next = { ...job, ...update };
  const target = path.join(dir, "done", `${job.id}.json`);
  writeJson(target, next);
  for (const candidate of [path.join(dir, `${job.id}.json`), path.join(dir, "claimed", `${job.id}.json`)]) {
    try {
      fs.unlinkSync(candidate);
    } catch {
      // already moved
    }
  }
}

export function completeJob(dir: string, job: QueueJob, result: QueueJob["result"], nowMs: number): QueueJob {
  const next: QueueJob = {
    ...job,
    status: result?.status === "SUCCESS" ? "done" : result?.status === "SKIPPED" ? "skipped" : "failed",
    result,
    lease: null,
    error: null,
  };
  void nowMs;
  moveToDone(dir, job, next);
  return next;
}

export function failJob(dir: string, job: QueueJob, error: string): QueueJob {
  const next: QueueJob = { ...job, status: "failed", lease: null, error };
  moveToDone(dir, job, next);
  return next;
}

// A queued job is cancelled outright; a claimed one only gets the flag, because
// the executor may already hold it (it checks before signing).
export function cancelJob(dir: string, id: string, nowMs: number): { ok: boolean; flagged?: boolean; reason?: string } {
  const queued = path.join(dir, `${id}.json`);
  const claimed = path.join(dir, "claimed", `${id}.json`);

  const inQueue = readJson(queued);
  if (inQueue) {
    writeJson(path.join(dir, "done", `${id}.json`), { ...inQueue, status: "cancelled", cancelledAt: new Date(nowMs).toISOString() });
    fs.unlinkSync(queued);
    return { ok: true };
  }
  const held = readJson(claimed);
  if (held) {
    writeJson(claimed, { ...held, cancelRequested: true, cancelledAt: new Date(nowMs).toISOString() });
    return { ok: true, flagged: true };
  }
  return { ok: false, reason: "job not found in the queue" };
}

// A crash (or a killed executor) must not strand a job: an expired lease puts
// it back in the queue until its attempts are used up.
export function reclaimStale(dir: string, opts: { nowMs: number; maxAttempts?: number }): string[] {
  const maxAttempts = opts.maxAttempts ?? 2;
  const reclaimed: string[] = [];
  const claimedDir = path.join(dir, "claimed");
  for (const file of jobList(claimedDir)) {
    if (file.endsWith(".tmp")) continue;
    const job = readJson(file);
    if (!job || job.status !== "claimed") continue;
    if (job.cancelRequested) {
      moveToDone(dir, job, { ...job, status: "cancelled", cancelledAt: new Date(opts.nowMs).toISOString() });
      reclaimed.push(job.id);
      continue;
    }
    if ((job.lease?.expiresAtMs ?? 0) > opts.nowMs) continue;
    if (job.attempts >= maxAttempts) {
      moveToDone(dir, job, { ...job, status: "failed", error: `lease expired after ${job.attempts} attempt(s)` });
      reclaimed.push(job.id);
      continue;
    }
    const restored: QueueJob = { ...job, status: "queued", lease: null };
    writeJson(path.join(dir, `${job.id}.json`), restored);
    fs.unlinkSync(file);
    reclaimed.push(job.id);
  }
  return reclaimed;
}

export interface QueueView extends QueueJob {
  view: "queued" | "claimed" | "done";
}

export function listJobs(dir: string, nowMs: number): QueueView[] {
  void nowMs;
  const read = (sub: string, view: QueueView["view"]): QueueView[] =>
    jobList(sub ? path.join(dir, sub) : dir)
      .map(readJson)
      .filter((job): job is QueueJob => job !== null)
      .map((job) => ({ ...job, view }));
  return [...read("", "queued"), ...read("claimed", "claimed"), ...read("done", "done")].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
}

// ── arming: the panel can enqueue freely (it spends nothing), but only an arm
// token handed out by the executor lets those jobs run ──────────────────────
const ARM_FILE = "ARMED.json";

export function createArmToken(): string {
  return randomBytes(16).toString("hex");
}

export function setArmed(dir: string, input: { token: string; nowMs: number; ttlMs?: number }): { ok: boolean; reason?: string } {
  const file = path.join(dir, ARM_FILE);
  const current = (() => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as { tokenHash?: string };
    } catch {
      return null;
    }
  })();
  const expected = current?.tokenHash ?? "";
  const presented = createHash("sha256").update(String(input.token)).digest("hex");
  if (!expected || presented !== expected) {
    return { ok: false, reason: "arm token does not match the one this executor printed" };
  }
  const ttlMs = input.ttlMs ?? 12 * 3_600_000;
  writeJson(file, {
    armedAt: new Date(input.nowMs).toISOString(),
    expiresAtMs: input.nowMs + ttlMs,
    tokenHash: expected,
  });
  return { ok: true };
}

// The executor publishes the hash of the token it printed; the token itself is
// never written to disk.
export function publishArmToken(dir: string, token: string): void {
  const hash = createHash("sha256").update(token).digest("hex");
  writeJson(path.join(dir, ARM_FILE), { tokenHash: hash, expiresAtMs: 0 });
}

export function isArmed(dir: string, nowMs: number): { armed: boolean; expiresAtMs?: number } {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, ARM_FILE), "utf8")) as { expiresAtMs?: number };
    if (!state?.expiresAtMs || state.expiresAtMs <= nowMs) return { armed: false };
    return { armed: true, expiresAtMs: state.expiresAtMs };
  } catch {
    return { armed: false };
  }
}

export function clearArmed(dir: string): { ok: boolean } {
  try {
    fs.unlinkSync(path.join(dir, ARM_FILE));
  } catch {
    // already disarmed
  }
  return { ok: true };
}
