import { existsSync } from "node:fs";
import path from "node:path";

interface ResolveStorePathOptions {
  explicitEnvVar: string;
  vercelTmpFile: string;
  defaultFileName: string;
}

function hasDataVolume(): boolean {
  return existsSync("/data");
}

export function resolveStorePath(options: ResolveStorePathOptions): string {
  const explicitPath = process.env[options.explicitEnvVar]?.trim();
  if (explicitPath) return explicitPath;

  if (process.env.VERCEL) {
    return path.join("/tmp", options.vercelTmpFile);
  }

  if (hasDataVolume()) {
    return path.join("/data", options.defaultFileName);
  }

  return path.join(process.cwd(), "data", options.defaultFileName);
}
