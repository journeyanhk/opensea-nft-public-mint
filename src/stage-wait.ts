export class MintApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function nextStage(drop: any, now: number) {
  if (!Array.isArray(drop.stages)) throw new Error("缺少 mint 排期。");
  const stages = drop.stages.map((stage: any) => {
    const start = Date.parse(stage.start_time), end = Date.parse(stage.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("mint 排期无效。");
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
      deps.log(`${error.message} 正在查找下一轮；尚未签名/发送交易。`);
      const boundary = deps.now();
      let next = nextStage(await deps.schedule(), boundary);
      if (!next) throw new Error("排期中没有下一个 mint 轮次。未发送交易。");
      deps.log(`等待 ${next.label}: ${new Date(next.start).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })} GMT+7。按 Ctrl+C 取消。`);
      while (deps.now() < next.start) {
        await deps.sleep(Math.min(30_000, next.start - deps.now()));
        // Refresh while waiting to follow creator edits, including moved/removed stages.
        const schedule = await deps.schedule();
        next = nextStage(schedule, boundary);
        if (!next) throw new Error("等待中的轮次已从排期移除。请重新检查 collection。");
      }
    }
  }
}
