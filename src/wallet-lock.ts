// A wallet may only be driven by one process at a time: nonces are a counter and
// two senders would collide on them. Two guards, in the order that makes the
// failure safe:
//
//   1. an OS-owned mutex — a listening socket on a port derived from the wallet
//      address. If the process dies for any reason (including kill -9) the OS
//      closes it, so a crash can never leave the wallet locked.
//   2. a pid/token file for diagnostics and stale-file recovery. It is written
//      only after the mutex is held, and it is removed only by its owner.
//
// The pattern (and the "only ESRCH proves the process is gone" rule) is taken
// from mint-desk's run-lock, which solves the same problem for its own runner.

import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";

export interface WalletLock {
  release: () => Promise<void>;
  recovered: boolean;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Only ESRCH proves the process is gone. Permission errors and anything
    // ambiguous must never cause a live lock to be removed.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function lockPort(wallet: string): number {
  return 20000 + (createHash("sha256").update(wallet.toLowerCase()).digest().readUInt32BE(0) % 40000);
}

export async function acquireWalletLock(wallet: string, dir: string): Promise<WalletLock> {
  const key = wallet.toLowerCase();
  const port = lockPort(key);
  fs.mkdirSync(dir, { recursive: true });

  const server = net.createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch {
    throw new Error(`wallet ${key} is already in use by another process (mutex port ${port} is taken)`);
  }
  const close = (): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

  const file = path.join(dir, `${key}.lock`);
  const token = randomUUID();
  let recovered = false;
  try {
    if (fs.existsSync(file)) {
      let previous: { pid?: unknown } | null = null;
      try {
        previous = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        throw new Error(`wallet lock file ${file} is unreadable — check the process before removing it`);
      }
      const pid = Number(previous?.pid);
      if (Number.isSafeInteger(pid) && pid > 0 && processExists(pid)) {
        throw new Error(`wallet ${key} is locked by pid ${pid}`);
      }
      fs.unlinkSync(file);
      recovered = true;
    }
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 2, pid: process.pid, token, port, startedUtc: new Date().toISOString() }),
      { mode: 0o600 }
    );
  } catch (err) {
    await close();
    throw err;
  }

  let released = false;
  return {
    recovered,
    release: async () => {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(fs.readFileSync(file, "utf8")) as { token?: string };
        if (current?.token === token) fs.unlinkSync(file);
      } catch {
        // already gone
      }
      await close();
    },
  };
}
