import chalk from "chalk";

// Pre-establish TCP/TLS to every RPC so the first real request doesn't pay for
// a handshake. Some endpoints (Base's sequencer, for one) only accept send
// methods, so we warm with eth_sendRawTransaction and ignore the error — the
// handshake is the point, not the response.
// Node's fetch keeps a connection for only a few seconds, and the gap between
// the last warm-up and T-0 is longer than that. Rather than take on a new
// dependency just to raise a pool timeout, re-warm on a short interval until the
// fire moment: the socket is then at most one interval old, and the call is
// fire-and-forget so it can never delay the send. eth_blockNumber is used rather
// than a bogus raw transaction — send-only endpoints answer with an error, but
// the handshake (the point) still happens, and no provider counts it as abuse.
export function keepWarm(
  rpcUrls: string[],
  opts: { untilMs: number; intervalMs?: number; fetchFn?: typeof fetch }
): () => void {
  const fetchFn = opts.fetchFn ?? fetch;
  const intervalMs = Math.max(500, opts.intervalMs ?? 2_000);
  const ping = (): void => {
    void Promise.all(
      rpcUrls.map((url) =>
        fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
        })
          .then(() => {})
          .catch(() => {})
      )
    );
  };
  ping();
  const timer = setInterval(() => {
    if (Date.now() >= opts.untilMs) {
      clearInterval(timer);
      return;
    }
    ping();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function warmConnections(rpcUrls: string[]): Promise<void> {
  console.log(chalk.gray("  Warming connections..."));

  await Promise.all(
    rpcUrls.map((url) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_sendRawTransaction",
          params: ["0x00"],
          id: 1,
        }),
      })
        .then(() => {})
        .catch(() => {})
    )
  );

  console.log(chalk.green("  Connections ready."));
}
