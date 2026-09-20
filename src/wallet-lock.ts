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
// An unrelated service can occupy the derived port by chance, so a taken port is
// stepped over unless the lock file names a live holder — "the port is busy" and
// "the wallet is in use" are different statements. The pattern (and the "only
// ESRCH proves the process is gone" rule) is taken from mint-desk's run-lock.

import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";

export interface WalletLock {
  release: () => Promise<void>;
  recovered: boolean;
  port: number;
}

export interface WalletLockOptions {
  port?: number; // override the hashed port (tests, or a known-good port)
  portTries?: number; // how many consecutive ports to try when one is taken
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

function readLockFile(file: string): { pid?: unknown; token?: unknown } | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown; token?: unknown };
  } catch {
    return null;
  }
}

async function listenOn(port: number): Promise<net.Server | { code: string }> {
  const server = net.createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    return server;
  } catch (err) {
    server.close();
    return { code: (err as NodeJS.ErrnoException).code ?? "EUNKNOWN" };
  }
}

export async function acquireWalletLock(
  wallet: string,
  dir: string,
  options: WalletLockOptions = {}
): Promise<WalletLock> {
  const key = wallet.toLowerCase();
  const basePort = options.port ?? lockPort(key);
  const tries = Math.max(1, options.portTries ?? 4);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${key}.lock`);

  let server: net.Server | null = null;
  let port = basePort;
  for (let offset = 0; offset < tries; offset++) {
    const candidate = basePort + offset;
    const attempt = await listenOn(candidate);
    if (!("code" in attempt)) {
      server = attempt;
      port = candidate;
      break;
    }
    if (attempt.code !== "EADDRINUSE") {
      throw new Error(`wallet ${key}: cannot bind mutex port ${candidate} (${attempt.code})`);
    }
    const holder = readLockFile(file);
    const holderPid = Number(holder?.pid);
    if (holder && Number.isSafeInteger(holderPid) && holderPid > 0 && processExists(holderPid)) {
      throw new Error(`wallet ${key} is locked by pid ${holderPid}`);
    }
    // No live holder: an unrelated occupant, step over it.
  }
  if (!server) {
    throw new Error(`wallet ${key}: no free mutex port in ${basePort}..${basePort + tries - 1}`);
  }
  const bound = server;
  const close = (): Promise<void> => new Promise((resolve) => bound.close(() => resolve()));

  const token = randomUUID();
  let recovered = false;
  try {
    if (fs.existsSync(file)) {
      const previous = readLockFile(file);
      if (previous === null) {
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
    port,
    release: async () => {
      if (released) return;
      released = true;
      try {
        const current = readLockFile(file);
        if (current?.token === token) fs.unlinkSync(file);
      } catch {
        // already gone
      }
      await close();
    },
  };
}
