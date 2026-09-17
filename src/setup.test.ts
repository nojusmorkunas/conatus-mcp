import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";

import { PACKAGE_NAME, createPrompt, findExistingCredentials, select, targetPaths } from "./setup.js";

describe("setup", () => {
  test("writes the package name npx can actually resolve", async () => {
    const pkg: { name: string } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

    expect(PACKAGE_NAME).toBe(pkg.name);
  });

  // Drives a real readline interface with terminal echo on. A hand-rolled fake would
  // only prove the mock echoes the way the implementation expects it to.
  function terminal() {
    const input = new PassThrough();
    const output = new PassThrough();
    const seen: string[] = [];
    output.on("data", (chunk) => seen.push(String(chunk)));
    const prompt = createPrompt(input, output as unknown as NodeJS.WritableStream & { write: (c: string) => boolean });
    const type = (text: string) => setTimeout(() => input.write(`${text}\n`), 5);
    return { prompt, type, written: () => seen.join("") };
  }

  test("never echoes a secret to the terminal", async () => {
    const secret = `tdm_${"a".repeat(32)}`;
    const { prompt, type, written } = terminal();

    type(secret);
    await expect(prompt.secret("Token: ")).resolves.toBe(secret);
    prompt.close();

    expect(written()).toContain("Token: ");
    expect(written()).not.toContain(secret);
    expect(written()).not.toMatch(/a{3,}/); // not even a fragment of it
  });

  test("still echoes ordinary answers", async () => {
    const { prompt, type, written } = terminal();

    type("https://tasks.example.com");
    await expect(prompt.question("URL: ")).resolves.toBe("https://tasks.example.com");
    prompt.close();

    expect(written()).toContain("tasks.example.com");
  });

  test("resumes echoing after the secret is read", async () => {
    const { prompt, type, written } = terminal();

    type(`tdm_${"b".repeat(32)}`);
    await prompt.secret("Token: ");
    type("visible-again");
    await prompt.question("Next: ");
    prompt.close();

    expect(written()).not.toMatch(/b{3,}/);
    expect(written()).toContain("visible-again");
  });

  test("offers Claude Code separately from Claude Desktop", () => {
    const targets = targetPaths();
    const byLabel = new Map(targets.map((target) => [target.label, target.path]));

    expect(byLabel.get("Claude Code")).toMatch(/\.claude\.json$/);
    expect(byLabel.get("Claude Desktop")).toMatch(/claude_desktop_config\.json$/);
    expect(byLabel.get("Claude Code")).not.toBe(byLabel.get("Claude Desktop"));
  });

  test("collects every distinct Conatus installation already configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "conatus-setup-"));
    const entry = (baseUrl: string, token: string) => ({
      mcpServers: { conatus: { command: "npx", args: ["-y", PACKAGE_NAME], env: { TASKS_BASE_URL: baseUrl, TASKS_API_TOKEN: token } } },
    });
    const write = async (name: string, body: unknown) => {
      const path = join(dir, name);
      await writeFile(path, JSON.stringify(body));
      return path;
    };
    const shared = `tdm_${"d".repeat(32)}`;
    const other = `tdc_${"f".repeat(32)}`;
    const unusable = [
      { label: "Missing", path: join(dir, "absent.json") },
      { label: "Broken", path: await write("broken.json", "not-an-object") },
      { label: "No Conatus", path: await write("bare.json", { mcpServers: { other: {} } }) },
      { label: "Bad token", path: await write("bad.json", entry("https://tasks.example.com", "nope")) },
      { label: "Bad URL", path: await write("badurl.json", entry("ftp://tasks.example.com", shared)) },
    ];
    const targets = [
      ...unusable,
      { label: "Claude Desktop", path: await write("desktop.json", entry("https://tasks.example.com", shared)) },
      { label: "Claude Code", path: await write("code.json", entry("https://tasks.example.com/", shared)) },
      { label: "Cursor", path: await write("cursor.json", entry("https://staging.example.com", other)) },
    ];

    // Same URL and token from two clients is one choice, credited to both.
    await expect(findExistingCredentials(targets)).resolves.toEqual([
      expect.objectContaining({ token: shared, labels: ["Claude Desktop", "Claude Code"] }),
      expect.objectContaining({ token: other, labels: ["Cursor"] }),
    ]);
    await expect(findExistingCredentials(unusable)).resolves.toEqual([]);
  });

  // Drives the picker with the escape sequences a real terminal sends, so the test
  // fails if the key decoding or the index bookkeeping breaks.
  describe("picker", () => {
    const DOWN = "\u001b[B";
    const UP = "\u001b[A";
    const ENTER = "\r";

    function picker(multiple: boolean) {
      const input = new PassThrough();
      const output = new PassThrough();
      output.resume(); // drain the repaints
      const choices = ["Claude Desktop", "Claude Code", "Cursor", "Another file"].map((label) => ({ label }));
      const result = select(input, output as unknown as NodeJS.WritableStream & { write: (c: string) => boolean }, "Pick", choices, multiple);
      return { press: (keys: string) => setTimeout(() => input.write(keys), 5), result };
    }

    test("ticks rows with space and confirms with enter", async () => {
      const { press, result } = picker(true);

      press(`${DOWN} ${DOWN}${DOWN} ${ENTER}`); // tick row 1, then row 3

      await expect(result).resolves.toEqual([1, 3]);
    });

    test("takes the highlighted row when nothing is ticked", async () => {
      const { press, result } = picker(true);

      press(`${DOWN}${DOWN}${ENTER}`);

      await expect(result).resolves.toEqual([2]);
    });

    test("ticks and unticks everything with a", async () => {
      const { press, result } = picker(true);

      press(`a${ENTER}`);
      await expect(result).resolves.toEqual([0, 1, 2, 3]);

      const second = picker(true);
      second.press(`aa${DOWN}${ENTER}`); // back to nothing ticked, so the cursor row wins
      await expect(second.result).resolves.toEqual([1]);
    });

    test("wraps around both ends", async () => {
      const { press, result } = picker(false);

      press(`${UP}${ENTER}`); // up from the first row lands on the last

      await expect(result).resolves.toEqual([3]);
    });

    test("ignores space when only one choice is allowed", async () => {
      const { press, result } = picker(false);

      press(`  ${DOWN}${ENTER}`);

      await expect(result).resolves.toEqual([1]);
    });

    test("keeps labels intact when the terminal reports no width", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      const painted: string[] = [];
      output.on("data", (chunk) => painted.push(String(chunk)));
      Object.assign(output, { columns: 0 }); // some ptys report exactly this
      const result = select(input, output as unknown as NodeJS.WritableStream & { write: (c: string) => boolean }, "Pick", [{ label: "Claude Desktop", hint: "~/.config/Claude/claude_desktop_config.json" }], true);

      setTimeout(() => input.write(ENTER), 5);
      await result;

      expect(painted.join("")).toContain("Claude Desktop  ~/.config/Claude/claude_desktop_config.json");
    });

    test("rejects on ctrl-c so nothing is written", async () => {
      const { press, result } = picker(true);

      press("\u0003");

      await expect(result).rejects.toThrow(/Nothing was written/);
    });
  });
});
