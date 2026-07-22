import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CheckArtifactStore, CheckArtifactWrite } from "./artifacts.js";

const safeSegment = (value: string): string => encodeURIComponent(value).replaceAll("%", "_");

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
    const local = relative(this.rootDirectory, target);
    if (local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error("The artifact path is outside the configured artifact root.");
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.content);
    return pathToFileURL(target).href;
  }
}
