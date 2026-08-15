export interface AccountProfileV1 {
  readonly formatVersion: 1;
  readonly sessionFile: string;
  readonly assetDir: string;
}

export interface AccountProfileRecord {
  readonly alias: string;
  readonly sessionFile: string;
  readonly assetDir: string;
}

export interface AccountProfileSummary {
  readonly alias: string;
  readonly status: "ready" | "missing-session" | "invalid";
  readonly buildId?: string;
}
