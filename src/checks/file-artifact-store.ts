import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CheckArtifactRead, CheckArtifactStore, CheckArtifactWrite } from "./artifacts.js";

const safeSegment = (value: string): string => encodeURIComponent(value).replaceAll("%", "_");

const assertInsideRoot = (rootDirectory: string, target: string): void => {
  const local = relative(rootDirectory, target);
  if (local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("The artifact path is outside the configured artifact root.");
  }
};

export class FileCheckArtifactStore implements CheckArtifactStore {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory);
  }

  async write(artifact: CheckArtifactWrite): Promise<string> {
    const target = resolve(
      this.rootDirectory,
      safeSegment(artifact.workflowId),
      safeSegment(artifact.nodeId),
      safeSegment(artifact.attemptId),
      safeSegment(artifact.name),
    );
    assertInsideRoot(this.rootDirectory, target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.content);
    return pathToFileURL(target).href;
  }

  async read(ref: string, maxBytes: number): Promise<CheckArtifactRead | undefined> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("The maximum artifact read size must be a positive integer.");
    let target: string;
    try {
      const url = new URL(ref);
      if (url.protocol !== "file:") return undefined;
      target = resolve(fileURLToPath(url));
    } catch {
      return undefined;
    }
    assertInsideRoot(this.rootDirectory, target);
    let metadata;
    try {
      metadata = await stat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!metadata.isFile()) return undefined;
    if (metadata.size > maxBytes) throw new Error("The check artifact exceeds the maximum read size.");
    return {
      ref,
      mediaType: target.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream",
      content: new Uint8Array(await readFile(target)),
    };
  }
}
