import { Wallet } from "ethers";

export function walletKeysFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const rawKeys = [env.PRIVATE_KEY || "", env.PRIVATE_KEYS || ""]
    .join("\n").split(/[\s,;]+/).filter(Boolean);
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rawKeys.entries()) {
    let wallet: Wallet;
    try {
      wallet = new Wallet(raw.startsWith("0x") ? raw : `0x${raw}`);
    } catch {
      // ethers errors may contain the supplied key: never forward them.
      throw new Error(`Invalid private key #${index + 1} in .env.`);
    }
    if (!seen.has(wallet.address)) {
      seen.add(wallet.address);
      keys.push(wallet.privateKey);
    }
  }
  return keys;
}
