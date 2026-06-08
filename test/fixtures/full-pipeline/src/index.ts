// Entry point — imports api + utils but NOT dead-helper.

import { loadConfig } from "./api";
import { formatBytes } from "./utils";

export async function main() {
  const cfg = await loadConfig();
  console.log("config:", cfg, "uptime cap:", formatBytes(1_000_000));
}
