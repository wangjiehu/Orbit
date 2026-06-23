import { ConfigLoader } from "@orbit-build/config";
import picocolors from "picocolors";

export function runConfig(cwd: string): void {
  const config = ConfigLoader.loadSync(cwd);
  console.log(picocolors.bold("\nResolved Orbit Configuration:\n"));
  console.log(JSON.stringify(config, null, 2));
}
