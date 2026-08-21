import { createInterface } from "node:readline/promises";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stdin as input, stdout as output } from "node:process";

type JsonConfig = { mcpServers?: Record<string, unknown>; [key: string]: unknown };

/** Must match the `name` field in package.json — this is what `npx` resolves. */
export const PACKAGE_NAME = "conatus-mcp";

type Prompt = {
  question: (query: string) => Promise<string>;
  secret: (query: string) => Promise<string>;
  close: () => void;
};

type Output = NodeJS.WritableStream & { write: (chunk: string) => boolean };

/**
 * A readline interface whose echo can be suppressed, so secrets never reach the
 * terminal or its scrollback.
 *
 * Every character readline echoes goes out through `output.write`, so wrapping that
 * one call is enough — no private readline internals are involved. The wrapper is a
 * Proxy rather than a fresh stream so that `isTTY`, `columns` and the cursor helpers
 * keep pointing at the real terminal.
 */
export function createPrompt(input: NodeJS.ReadableStream, output: Output): Prompt {
  let muted = false;
  const maskable = new Proxy(output, {
    get(target, property, receiver) {
      if (property === "write") {
        return (chunk: string, ...rest: unknown[]) =>
          muted ? true : (target.write as (...args: unknown[]) => boolean)(chunk, ...rest);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const rl = createInterface({ input, output: maskable, terminal: true });

  return {
    question: (query) => rl.question(query),
    secret: async (query) => {
      output.write(query);
      muted = true;
      try {
        return await rl.question("");
      } finally {
        muted = false;
        output.write("\n"); // readline's own newline was swallowed while muted.
      }
    },
    close: () => rl.close(),
  };
}

type ClientTarget = {
  label: string;
  path: string;
};

export function targetPaths(): ClientTarget[] {
  const home = homedir();
  const desktopDir =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support", "Claude")
      : process.platform === "win32"
        ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude")
        : join(home, ".config", "Claude");
  return [
    { label: "Claude Desktop", path: join(desktopDir, "claude_desktop_config.json") },
    // Claude Code keeps user-scope servers in ~/.claude.json on every platform, and
    // does not read claude_desktop_config.json.
    { label: "Claude Code", path: join(home, ".claude.json") },
    { label: "Cursor", path: join(home, ".cursor", "mcp.json") },
  ];
}

async function readConfig(path: string): Promise<JsonConfig> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must contain a JSON object");
    }
    return parsed as JsonConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Couldn't read ${path}: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value.trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error("The Conatus URL must start with http:// or https://.");
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

async function verifyConnection(baseUrl: URL, token: string) {
  const response = await fetch(new URL("/api/v1/context", baseUrl), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Conatus rejected that URL or API token. Nothing was written.");
}

export async function runSetup() {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Setup needs an interactive terminal. Configure TASKS_BASE_URL and TASKS_API_TOKEN directly for non-interactive use.");
  }
  const prompt = createPrompt(input, output);
  try {
    const baseUrl = normalizeBaseUrl(await prompt.question("Conatus URL (for example https://tasks.example.com): "));
    const token = (await prompt.secret("Scoped Conatus API token: ")).trim();
    if (!/^(?:tdc|tdm)_[A-Za-z0-9_-]{32}$/.test(token)) {
      throw new Error("That API token has an invalid format. Nothing was written.");
    }
    output.write("Checking the connection…\n");
    await verifyConnection(baseUrl, token);

    const targets = targetPaths();
    targets.forEach((target, index) => output.write(`${index + 1}. ${target.label} (${target.path})\n`));
    output.write(`${targets.length + 1}. Another JSON MCP config file\n`);
    const selection = Number(await prompt.question("Choose a client: "));
    let configPath: string;
    if (selection >= 1 && selection <= targets.length) {
      configPath = targets[selection - 1].path;
    } else if (selection === targets.length + 1) {
      configPath = (await prompt.question("Path to JSON MCP config: ")).trim();
      if (!configPath) throw new Error("No config path was provided. Nothing was written.");
    } else {
      throw new Error("Choose one of the displayed options. Nothing was written.");
    }

    const config = await readConfig(configPath);
    const servers = { ...(config.mcpServers ?? {}) };
    servers.conatus = {
      command: "npx",
      args: ["-y", PACKAGE_NAME],
      env: { TASKS_BASE_URL: baseUrl.href.replace(/\/$/, ""), TASKS_API_TOKEN: token },
    };
    config.mcpServers = servers;
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(configPath, 0o600);
    output.write(`Conatus MCP was added to ${configPath}. Restart your client to load it.\n`);
  } finally {
    prompt.close();
  }
}
