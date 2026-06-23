import { execSync } from "child_process";
import picocolors from "picocolors";
import { ConfigLoader } from "@orbit-build/config";

export function runDoctor(cwd: string): void {
  console.log(picocolors.bold("\nOrbit Environment Diagnostics:\n"));

  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.replace("v", "").split(".")[0], 10);
  if (major >= 20) {
    console.log(
      picocolors.green(`✔ Node.js version: ${nodeVersion} (Supported)`),
    );
  } else {
    console.log(
      picocolors.red(
        `✖ Node.js version: ${nodeVersion} (Requires Node.js 20+)`,
      ),
    );
  }

  try {
    const gitVersion = execSync("git --version", { encoding: "utf8" }).trim();
    console.log(picocolors.green(`✔ Git: ${gitVersion}`));
  } catch {
    console.log(
      picocolors.yellow(
        `⚠ Git: Not detected in environment path. Sandbox rollbacks will use filesystem backups.`,
      ),
    );
  }

  try {
    const rgVersion = execSync("rg --version", { encoding: "utf8" })
      .trim()
      .split("\n")[0];
    console.log(picocolors.green(`✔ Ripgrep (rg): ${rgVersion}`));
  } catch {
    console.log(
      picocolors.yellow(
        `⚠ Ripgrep (rg): Not detected. Code searches will use Node-based stream scanning.`,
      ),
    );
  }

  const config = ConfigLoader.loadSync(cwd);
  const defaultProvider = config.provider.default;
  const providerDetails = config.providers[defaultProvider];

  if (providerDetails?.apiKey) {
    console.log(
      picocolors.green(
        `✔ API Key: Loaded for default provider "${defaultProvider}"`,
      ),
    );
  } else {
    console.log(
      picocolors.red(
        `✖ API Key: Missing for default provider "${defaultProvider}". Configure ${providerDetails?.apiKeyEnv || "API keyenv"}`,
      ),
    );
  }
}
