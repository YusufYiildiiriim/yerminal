export type CommitInfo = { id: string; shortId: string; message: string; author: string; timestamp: number; parents: string[]; branches: string[] };
export type CommitFileChange = { path: string; kind: string };
