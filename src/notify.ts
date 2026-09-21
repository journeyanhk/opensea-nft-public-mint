// Minimal notifications for an unattended executor.
//
// Three events matter: a job finished (with its outcome), the executor stopped
// heartbeating, and the calendar canary fired. Everything else can wait for a
// look at the panel.
//
// Delivery is fire-and-forget: a webhook that is down, slow or misconfigured
// must never affect a mint. NOTIFY_WEBHOOK accepts a Telegram sendMessage URL
// (with NOTIFY_TELEGRAM_CHAT_ID) or any endpoint that takes a JSON body.

export interface NotifyEvent {
  kind: "job-finished" | "executor-stale" | "calendar-canary";
  title: string;
  detail?: string;
  at?: string;
}

export interface NotifyRequest {
  url: string;
  body: unknown;
}

// Pure so the payload shape can be tested without a network.
export function buildNotifyRequest(
  webhook: string | undefined,
  event: NotifyEvent,
  chatId?: string | undefined
): NotifyRequest | null {
  const url = (webhook ?? "").trim();
  if (!url) return null;
  const at = event.at ?? new Date().toISOString();
  const text = [event.title, event.detail].filter(Boolean).join("\n");
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith("telegram.org")) {
      if (!chatId) return null; // a Telegram call without a chat id is a 400
      return { url, body: { chat_id: chatId, text: `[nft] ${text}\n${at}` } };
    }
    return { url, body: { ...event, at, source: "nft-public-mint" } };
  } catch {
    return null;
  }
}

export function heartbeatStale(
  heartbeat: { at?: string } | null | undefined,
  nowMs: number,
  thresholdMs = 5 * 60_000
): boolean {
  const at = heartbeat?.at ? Date.parse(heartbeat.at) : NaN;
  if (!Number.isFinite(at)) return false; // never seen: not "stale", just absent
  return nowMs - at > thresholdMs;
}

export interface Notifier {
  send: (event: NotifyEvent) => void;
}

export function createNotifier(
  webhook: string | undefined = process.env.NOTIFY_WEBHOOK,
  chatId: string | undefined = process.env.NOTIFY_TELEGRAM_CHAT_ID,
  fetchFn: typeof fetch = fetch
): Notifier {
  return {
    send: (event) => {
      const request = buildNotifyRequest(webhook, event, chatId);
      if (!request) return;
      try {
        void fetchFn(request.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request.body),
          signal: AbortSignal.timeout(5_000),
        }).catch(() => {});
      } catch {
        // notifications never block or fail a mint
      }
    },
  };
}
