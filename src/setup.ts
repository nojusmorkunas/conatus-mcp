import { clearScreenDown, emitKeypressEvents, moveCursor } from "node:readline";
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

type Output = NodeJS.WritableStream & { write: (chunk: string) => boolean; columns?: number };

type Input = NodeJS.ReadableStream & { setRawMode?: (mode: boolean) => void };

/**
 * Line prompts whose echo can be suppressed, so secrets never reach the terminal or
 * its scrollback.
 *
 * Every character readline echoes goes out through `output.write`, so wrapping that
 * one call is enough — no private readline internals are involved. The wrapper is a
 * Proxy rather than a fresh stream so that `isTTY`, `columns` and the cursor helpers
 * keep pointing at the real terminal.
 *
 * Each question opens its own interface, because `select` needs raw keypresses from
 * the same stream and readline will not share it.
 */
export function createPrompt(input: Input, output: Output): Prompt {
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

  async function ask(query: string, mute: boolean) {
    const rl = createInterface({ input, output: maskable, terminal: true });
    try {
      if (!mute) return await rl.question(query);
      output.write(query);
      muted = true;
      try {
        return await rl.question("");
      } finally {
        muted = false;
        output.write("\n"); // readline's own newline was swallowed while muted.
      }
    } finally {
      rl.close();
    }
  }

  return {
    question: (query) => ask(query, false),
    secret: (query) => ask(query, true),
    close: () => input.pause(),
  };
}

export type Choice = { label: string; hint?: string };

type Key = { name?: string; ctrl?: boolean };

const cyan = (text: string) => `\u001b[36m${text}\u001b[39m`;

/**
 * An arrow-key picker: up and down move, space ticks a row when `multiple`, `a` ticks
 * everything, enter confirms, escape or ctrl-c cancels. Confirming with nothing ticked
 * takes the highlighted row, so picking one thing never needs the space bar. Resolves
 * to the chosen 0-based indexes, in menu order.
 *
 * node:readline already decodes keypresses and moves the cursor, so this needs no
 * prompt library.
 */
export function select(
  input: Input,
  output: Output,
  title: string,
  choices: Choice[],
  multiple = false,
): Promise<number[]> {
  const ticked = new Set<number>();
  let cursor = 0;
  let painted = 0;

  const paint = () => {
    if (painted) {
      moveCursor(output, 0, -painted);
      clearScreenDown(output);
    }
    // ponytail: one terminal row per choice. Long rows are truncated rather than
    // wrapped, because a wrapped row would desync the repaint's line count.
    // `||` not `??`: a pty that reports no width at all sets columns to 0, and a zero
    // width would slice every label away from the right.
    const width = (output.columns || 80) - 1;
    const fit = (line: string) => (line.length > width ? `${line.slice(0, width - 1)}…` : line);
    const keys = multiple ? "space to tick, a for all, enter to confirm" : "enter to confirm";
    const lines = [
      fit(`${title} (${keys})`),
      ...choices.map((choice, index) => {
        const here = index === cursor;
        const mark = multiple ? (ticked.has(index) ? "[x]" : "[ ]") : here ? "(*)" : "( )";
        const line = fit(`${here ? ">" : " "} ${mark} ${choice.label}${choice.hint ? `  ${choice.hint}` : ""}`);
        return here ? cyan(line) : line;
      }),
    ];
    output.write(`${lines.join("\n")}\n`);
    painted = lines.length;
  };

  return new Promise((resolve, reject) => {
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.resume();
    output.write("\u001b[?25l"); // hide the cursor while the list repaints
    paint();

    const stop = () => {
      input.off("keypress", onKey);
      input.setRawMode?.(false);
      input.pause();
      output.write("\u001b[?25h");
    };

    function onKey(_char: string, key: Key) {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        stop();
        reject(new Error("Setup was cancelled. Nothing was written."));
        return;
      }
      switch (key.name) {
        case "up":
        case "k":
          cursor = (cursor + choices.length - 1) % choices.length;
          break;
        case "down":
        case "j":
          cursor = (cursor + 1) % choices.length;
          break;
        case "space":
          if (!multiple) return;
          if (!ticked.delete(cursor)) ticked.add(cursor);
          break;
        case "a":
          if (!multiple) return;
          if (ticked.size === choices.length) ticked.clear();
          else choices.forEach((_choice, index) => ticked.add(index));
          break;
        case "return":
          stop();
          resolve(ticked.size > 0 ? [...ticked].sort((left, right) => left - right) : [cursor]);
          return;
        default:
          return;
      }
      paint();
    }

    input.on("keypress", onKey);
  });
}

type ClientTarget = {
  label: string;
  path: string;
};

type Credentials = {
  baseUrl: URL;
  token: string;
};

/** Credentials already in use, and the clients using them. */
type Installation = Credentials & { labels: string[] };

const TOKEN_PATTERN = /^(?:tdc|tdm)_[A-Za-z0-9_-]{32}$/;

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

const serverUrl = (url: URL) => url.href.replace(/\/$/, "");

/** The Conatus credentials one client config holds, if it still holds a usable pair. */
async function credentialsIn(path: string): Promise<Credentials | undefined> {
  let config: JsonConfig;
  try {
    config = await readConfig(path);
  } catch {
    return undefined; // A config we can't parse is not a credential source.
  }
  const env = (config.mcpServers?.conatus as { env?: Record<string, unknown> } | undefined)?.env;
  const token = env?.TASKS_API_TOKEN;
  const baseUrl = env?.TASKS_BASE_URL;
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return undefined;
  if (typeof baseUrl !== "string") return undefined;
  try {
    return { baseUrl: normalizeBaseUrl(baseUrl), token };
  } catch {
    return undefined;
  }
}

/**
 * Every distinct Conatus installation earlier runs left behind, each labelled with the
 * clients already pointed at it. URL and token travel together, because a scoped token
 * is only valid against the installation that issued it, so two clients sharing a pair
 * collapse into one choice.
 */
export async function findExistingCredentials(targets: ClientTarget[]): Promise<Installation[]> {
  const found = new Map<string, Installation>();
  for (const target of targets) {
    const credentials = await credentialsIn(target.path);
    if (!credentials) continue;
    const key = `${serverUrl(credentials.baseUrl)}\u0000${credentials.token}`;
    const already = found.get(key);
    if (already) already.labels.push(target.label);
    else found.set(key, { ...credentials, labels: [target.label] });
  }
  return [...found.values()];
}

async function writeServerEntry(configPath: string, { baseUrl, token }: Credentials) {
  const config = await readConfig(configPath);
  config.mcpServers = {
    ...(config.mcpServers ?? {}),
    conatus: {
      command: "npx",
      args: ["-y", PACKAGE_NAME],
      env: { TASKS_BASE_URL: serverUrl(baseUrl), TASKS_API_TOKEN: token },
    },
  };
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
}

async function verifyConnection(baseUrl: URL, token: string) {
  const response = await fetch(new URL("/api/v1/context", baseUrl), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Conatus rejected that URL or API token. Nothing was written.");
}

async function askCredentials(prompt: Prompt): Promise<Credentials> {
  const existing = await findExistingCredentials(targetPaths());
  if (existing.length > 0) {
    const [choice] = await select(
      input,
      output,
      "Which Conatus installation should these clients use?",
      [
        ...existing.map((installation) => ({
          label: serverUrl(installation.baseUrl),
          hint: `from ${installation.labels.join(", ")}`,
        })),
        { label: "A different Conatus URL and API token" },
      ],
    );
    if (choice < existing.length) return existing[choice];
  }
  const baseUrl = normalizeBaseUrl(await prompt.question("Conatus URL (for example https://tasks.example.com): "));
  const token = (await prompt.secret("Scoped Conatus API token: ")).trim();
  if (!TOKEN_PATTERN.test(token)) throw new Error("That API token has an invalid format. Nothing was written.");
  return { baseUrl, token };
}

export async function runSetup() {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Setup needs an interactive terminal. Configure TASKS_BASE_URL and TASKS_API_TOKEN directly for non-interactive use.");
  }
  const prompt = createPrompt(input, output);
  try {
    const credentials = await askCredentials(prompt);
    output.write("Checking the connection…\n");
    await verifyConnection(credentials.baseUrl, credentials.token);

    const targets = targetPaths();
    const picks = await select(
      input,
      output,
      "Install into which clients?",
      [
        ...targets.map((target) => ({ label: target.label, hint: target.path })),
        { label: "Another JSON MCP config file" },
      ],
      true,
    );

    // Resolve every path before writing anything, so a bad answer still leaves the
    // "nothing was written" promise true.
    const paths: string[] = [];
    for (const pick of picks) {
      if (pick < targets.length) {
        paths.push(targets[pick].path);
        continue;
      }
      const custom = (await prompt.question("Path to JSON MCP config: ")).trim();
      if (!custom) throw new Error("No config path was provided. Nothing was written.");
      paths.push(custom);
    }

    for (const path of paths) {
      await writeServerEntry(path, credentials);
      output.write(`Conatus MCP was added to ${path}\n`);
    }
    output.write(`Restart ${paths.length > 1 ? "those clients" : "that client"} to load it.\n`);
  } finally {
    prompt.close();
  }
}
