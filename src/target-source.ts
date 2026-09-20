// Where targets come from.
//
// Today that is one config file plus the files `--watch` merges in. B5 adds the
// execution queue directory, and the executor will need the same "give me the
// current target list" question answered from a different place. Keeping the
// question behind one interface means the runner does not learn a second file
// format later — only a second source.
//
// Sources are synchronous on purpose: the runner's poll loop is already
// synchronous (fs reads), and an async source here would move the loading order
// around for no benefit.

import fs from "fs";
import { RawConfig, mergeRawConfigs } from "./batch-watch";

export interface TargetSource {
  readonly name: string;
  read(): RawConfig;
  watchPaths(): string[];
}

function parseConfig(file: string, tolerateMissing: boolean): RawConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (tolerateMissing) return { targets: [] };
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text) as RawConfig;
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

export function fileTargetSource(file: string): TargetSource {
  return {
    name: file,
    watchPaths: () => [file],
    read: () => parseConfig(file, false),
  };
}

export interface WatchHooks {
  onAppear?: (file: string) => void;
  onMissing?: (file: string) => void;
  tolerateMissingMain?: boolean;
}

export function watchTargetSource(mainFile: string, watchFiles: string[], hooks: WatchHooks = {}): TargetSource {
  const missing = new Set<string>();
  const readWatched = (file: string): RawConfig => {
    if (fs.existsSync(file)) {
      if (missing.delete(file)) hooks.onAppear?.(file);
      return parseConfig(file, false);
    }
    if (!missing.has(file)) {
      missing.add(file);
      hooks.onMissing?.(file);
    }
    return { targets: [] };
  };

  return {
    name: mainFile,
    watchPaths: () => [mainFile, ...watchFiles],
    read: () => mergeRawConfigs(parseConfig(mainFile, hooks.tolerateMissingMain === true), watchFiles.map(readWatched)),
  };
}
