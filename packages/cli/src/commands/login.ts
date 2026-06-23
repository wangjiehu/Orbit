import readline from "readline";
import picocolors from "picocolors";
import { CredentialsManager } from "@orbit-build/config";

interface ProviderChoice {
  name: string;
  envVar: string;
}

const PROVIDERS: Record<string, ProviderChoice> = {
  "1": { name: "deepseek-openai", envVar: "DEEPSEEK_API_KEY" },
  "2": { name: "openai", envVar: "OPENAI_API_KEY" },
  "3": { name: "anthropic", envVar: "ANTHROPIC_API_KEY" },
  "4": { name: "deepseek-anthropic", envVar: "ANTHROPIC_AUTH_TOKEN" },
};

function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askSecret(query: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const stdin = process.stdin as any;
    const stdout = process.stdout as any;

    stdout.write(query);
    stdin.setRawMode(true);
    stdin.resume();

    let input = "";

    const onData = (char: Buffer) => {
      const charStr = char.toString("utf8");
      switch (charStr) {
        case "\n":
        case "\r":
        case "\u0004": // EOF
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          stdout.write("\n");
          rl.close();
          resolve(input.trim());
          break;
        case "\u0003": // Ctrl+C
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          stdout.write("\n");
          rl.close();
          process.exit(130);
          break;
        case "\u0008":
        case "\x7f": // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            stdout.write("\r" + query + "*".repeat(input.length) + " ");
            stdout.write("\r" + query + "*".repeat(input.length));
          }
          break;
        default:
          if (charStr.charCodeAt(0) >= 32) {
            input += charStr;
            stdout.write("*");
          }
          break;
      }
    };

    stdin.on("data", onData);
  });
}

export async function runLogin(): Promise<void> {
  console.log(picocolors.bold("\n--- Configure Orbit API Keys ---"));
  console.log("Select an API provider to configure:\n");
  
  for (const [key, provider] of Object.entries(PROVIDERS)) {
    console.log(`  ${picocolors.cyan(key)}) ${picocolors.bold(provider.name)} (saves to ${provider.envVar})`);
  }
  console.log("");

  const choice = await askQuestion("Enter your choice (1-4): ");
  const provider = PROVIDERS[choice];

  if (!provider) {
    console.log(picocolors.red("\n✖ Invalid choice. Exiting."));
    return;
  }

  console.log(picocolors.cyan(`\nConfiguring API Key for provider "${picocolors.bold(provider.name)}"...`));
  const apiKey = await askSecret("Enter API Key (input will be hidden): ");

  if (!apiKey) {
    console.log(picocolors.red("\n✖ API Key cannot be empty. Exiting."));
    return;
  }

  try {
    const credsManager = new CredentialsManager();
    credsManager.storeSecret(provider.envVar, apiKey);
    console.log(picocolors.green(`\n✔ API Key for "${provider.name}" stored securely!`));
  } catch (error: any) {
    console.log(picocolors.red(`\n✖ Failed to store API Key securely: ${error.message}`));
  }
}
