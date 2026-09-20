// Target jobs: the state a single target moves through while several of them
// share a handful of wallets.
//
// The runner executes one job at a time today; parallelism needs the same
// bookkeeping the review asked for: waiting (parked until the prepare window),
// preparing (re-read, gates, signing — no wallet lane held), sending (the lane
// is held), receipt (waiting, renewing the lease), and the terminal states.
//
// Kept pure so the transitions and the "who may start now" decision are
// testable without a chain, and so the runner and the future executor share one
// definition of a job.

import { orderJobs, ScheduledJob } from "./batch-coordinator";

export type JobState = "waiting" | "preparing" | "sending" | "receipt" | "done" | "failed" | "skipped";

export const TERMINAL_STATES: JobState[] = ["done", "failed", "skipped"];

export type JobEvent = "prepare" | "lane" | "receipt" | "done" | "fail" | "skip";

const TRANSITIONS: Record<JobState, Partial<Record<JobEvent, JobState>>> = {
  waiting: { prepare: "preparing", fail: "failed", skip: "skipped" },
  preparing: { lane: "sending", fail: "failed", skip: "skipped" },
  sending: { receipt: "receipt", fail: "failed", skip: "skipped" },
  receipt: { done: "done", fail: "failed" },
  done: {},
  failed: {},
  skipped: {},
};

export interface TargetJob {
  id: string; // chain|contract
  contract: string;
  startMs: number;
  wallets: string[];
  priority: number;
  state: JobState;
}

export interface JobTarget {
  id?: string;
  contract: string;
  startMs: number;
  wallets: string[];
  priority?: number;
}

export function createJobs(targets: JobTarget[], _nowMs: number): TargetJob[] {
  const scheduled: ScheduledJob[] = targets.map((target) => ({
    id: target.id ?? target.contract,
    wallets: target.wallets,
    startMs: target.startMs,
    priority: target.priority ?? 0,
  }));
  const { order } = orderJobs(scheduled);
  const byId = new Map(targets.map((target) => [target.id ?? target.contract, target]));
  return order.map((id) => {
    const target = byId.get(id)!;
    return {
      id,
      contract: target.contract,
      startMs: target.startMs,
      wallets: target.wallets.map((wallet) => wallet.toLowerCase()),
      priority: target.priority ?? 0,
      state: "waiting" as JobState,
    };
  });
}

export function advance(job: TargetJob, event: JobEvent): boolean {
  const next = TRANSITIONS[job.state][event];
  if (!next) return false;
  job.state = next;
  return true;
}

// A job may start preparing once its start time is inside the prepare window.
// Terminal jobs never do.
export function jobsToPrepare(jobs: TargetJob[], nowMs: number, prepareWindowMs: number): TargetJob[] {
  return jobs
    .filter((job) => !TERMINAL_STATES.includes(job.state))
    .filter((job) => job.startMs - nowMs <= prepareWindowMs)
    .sort((a, b) => a.startMs - b.startMs || b.priority - a.priority || a.id.localeCompare(b.id));
}
