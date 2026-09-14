export class MintApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function nextStage(drop: any, now: number) {
  if (!Array.isArray(drop.stages)) throw new Error("Missing mint schedule.");
  const stages = drop.stages.map((stage: any) => {
    const start = Date.parse(stage.start_time), end = Date.parse(stage.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("Invalid mint schedule.");
    return { start, end, label: String(stage.label || stage.stage_type) };
  });
  return stages.filter((stage: any) => stage.start > now).sort((a: any, b: any) => a.start - b.start)[0] as
    { start: number; end: number; label: string } | undefined;
}

// Dependencies are injected so transitions can be tested without waiting or signing.
export async function waitForEligibleStage<T>(deps: {
  check: () => Promise<T>;
  schedule: () => Promise<any>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}): Promise<T> {
  for (;;) {
    try { return await deps.check(); }
    catch (error) {
      // 422 has multiple causes. Do not label it "not eligible".
      // Authentication, rate limits, RPC and malformed transaction errors stop.
      if (!(error instanceof MintApiError) || ![409, 422].includes(error.status)) throw error;
      deps.log(`${error.message} Looking for the next stage; nothing signed or sent.`);
      const boundary = deps.now();
      let next = nextStage(await deps.schedule(), boundary);
      if (!next) throw new Error("No next mint stage in the schedule. Nothing was sent.");
      deps.log(`Waiting for ${next.label}: ${new Date(next.start).toLocaleString("en-US", { timeZone: "Asia/Shanghai" })} GMT+8. Ctrl+C to cancel.`);
      while (deps.now() < next.start) {
        await deps.sleep(Math.min(30_000, next.start - deps.now()));
        // Refresh while waiting to follow creator edits, including moved/removed stages.
        const schedule = await deps.schedule();
        next = nextStage(schedule, boundary);
        if (!next) throw new Error("The awaited stage was removed from the schedule. Re-check the collection.");
      }
    }
  }
}
