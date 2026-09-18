import { execFileSync } from "node:child_process";

export const PROJECT_ID = "uk_amazon_seller_asin";
export const BUSINESS_CONTRACT_VERSION = "seller-ids-b-v1";

export function currentGitCommit(projectRoot: string): string {
  const fromEnvironment = process.env.GIT_COMMIT?.trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export function runContractHash(schema: number, configHash: string, sourceHash: string, asOfDate: string): string {
  return `${PROJECT_ID}:${BUSINESS_CONTRACT_VERSION}:${schema}:${configHash}:${sourceHash}:${asOfDate}`;
}
