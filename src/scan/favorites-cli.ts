// Export the favorites store as JSONL: the labelled dataset a later analysis
// joins with ledger and backfill outcomes.

import fs from "fs";
import chalk from "chalk";
import { DEFAULT_FAVORITES_PATH, loadFavorites, toJsonl } from "./favorites";

export function parseExportFavoritesArgs(args: string[]): { file: string | null; favoritesPath: string } {
  const index = args.indexOf("--export-favorites");
  const rest = args.slice(index + 1);
  let file: string | null = null;
  let favoritesPath = DEFAULT_FAVORITES_PATH;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--favorites") favoritesPath = rest[++i] ?? DEFAULT_FAVORITES_PATH;
    else if (arg.startsWith("--")) throw new Error(`Unknown option "${arg}"`);
    else file = arg;
  }
  return { file, favoritesPath };
}

export async function runExportFavoritesCommand(args: string[]): Promise<void> {
  const { file, favoritesPath } = parseExportFavoritesArgs(args);
  const store = loadFavorites(favoritesPath);
  const count = Object.keys(store.favorites).length;
  const jsonl = toJsonl(store);
  if (file) {
    fs.writeFileSync(file, jsonl);
    console.log(chalk.green(`  ${count} favorite(s) written to ${file}`));
  } else {
    process.stdout.write(jsonl);
  }
  if (count > 0 && !file) console.log(chalk.gray(`  ${count} favorite(s)`));
}
