export interface CheckArtifactWrite {
  workflowId: string;
  nodeId: string;
  attemptId: string;
  name: string;
  mediaType: string;
  content: Uint8Array;
}

export interface CheckArtifactStore {
  write(artifact: CheckArtifactWrite): Promise<string>;
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
}
