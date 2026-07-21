import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const blockedName = ["work", "graph"].join("");
const textExtensions = new Set([".ts", ".md", ".json", ".yml", ".yaml"]);
const ignoredDirectories = new Set([".git", "node_modules", "coverage", "dist"]);

async function textFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: URL[] = [];

  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) files.push(...await textFiles(child));
    else if (textExtensions.has(extname(entry.name))) files.push(child);
  }

  return files;
}

describe("repository naming", () => {
  it("uses only the Hypagraph product name", async () => {
    const matches: string[] = [];

    for (const file of await textFiles(root)) {
      if (file.pathname.endsWith("tests/naming.test.ts")) continue;
      const content = await readFile(file, "utf8");
      if (content.toLowerCase().includes(blockedName)) {
        matches.push(relative(root.pathname, file.pathname));
      }
    }

    expect(matches).toEqual([]);
  });
});
