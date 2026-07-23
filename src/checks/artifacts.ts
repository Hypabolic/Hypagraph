export interface CheckArtifactWrite {
  workflowId: string;
  nodeId: string;
  attemptId: string;
  name: string;
  mediaType: string;
  content: Uint8Array;
}

export interface CheckArtifactRead {
  ref: string;
  mediaType: string;
  content: Uint8Array;
}

export interface CheckArtifactStore {
  write(artifact: CheckArtifactWrite): Promise<string>;
  read(ref: string, maxBytes: number): Promise<CheckArtifactRead | undefined>;
}

export interface StoredCheckArtifact extends CheckArtifactWrite {
  ref: string;
}

export class MemoryCheckArtifactStore implements CheckArtifactStore {
  readonly artifacts = new Map<string, StoredCheckArtifact>();

  async write(artifact: CheckArtifactWrite): Promise<string> {
    const ref = `memory://checks/${encodeURIComponent(artifact.workflowId)}/${encodeURIComponent(artifact.nodeId)}/${encodeURIComponent(artifact.attemptId)}/${encodeURIComponent(artifact.name)}`;
    this.artifacts.set(ref, { ...artifact, content: new Uint8Array(artifact.content), ref });
    return ref;
  }

  async read(ref: string, maxBytes: number): Promise<CheckArtifactRead | undefined> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("The maximum artifact read size must be a positive integer.");
    const artifact = this.artifacts.get(ref);
    if (!artifact) return undefined;
    if (artifact.content.byteLength > maxBytes) throw new Error("The check artifact exceeds the maximum read size.");
    return {
      ref: artifact.ref,
      mediaType: artifact.mediaType,
      content: new Uint8Array(artifact.content),
    };
  }
}
