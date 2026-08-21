import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";

import { PACKAGE_NAME, createPrompt, targetPaths } from "./setup.js";

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
});
