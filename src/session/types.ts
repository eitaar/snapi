export interface AssetRecord {
  readonly kind: "javascript" | "wasm";
  readonly filename: string;
  readonly sha256: string;
  readonly size: number;
}

export interface IndexedDbSnapshot {
  readonly databases: readonly IndexedDbDatabaseSnapshot[];
}

export interface IndexedDbIndexSnapshot {
  readonly name: string;
  readonly keyPath: string | readonly string[];
  readonly unique: boolean;
  readonly multiEntry: boolean;
}

export interface IndexedDbRecordSnapshot {
  readonly key: unknown;
  readonly value: unknown;
}

export interface IndexedDbStoreSnapshot {
  readonly name: string;
  readonly keyPath: string | readonly string[] | null;
  readonly autoIncrement: boolean;
  readonly indexes: readonly IndexedDbIndexSnapshot[];
  readonly records: readonly IndexedDbRecordSnapshot[];
}

export interface IndexedDbDatabaseSnapshot {
  readonly name: string;
  readonly version: number;
  readonly stores: readonly IndexedDbStoreSnapshot[];
}

export interface MessagingStateExport {
  readonly keyInitializationInfo?: string;
  readonly rootWrappingKey?: {
    readonly data: string;
    readonly identityKeyId: string;
  };
  readonly friendDevices: Readonly<
    Record<string, readonly Readonly<Record<string, unknown>>[]>
  >;
}

export interface SessionExport {
  readonly formatVersion: 1;
  readonly accountId: string;
  readonly buildId: "8dd50222";
  readonly exportedAt: string;
  readonly auth: {
    readonly httpToken: string;
    readonly gatewayToken: string;
    readonly tokenRefreshedAt?: string;
    readonly gatewayTokenCapturedAt?: string;
    readonly webSessionRefreshedAt?: string;
    readonly cookieHeader: string;
    readonly ssoCookieHeader?: string;
    readonly ssoScuid?: string;
    readonly ssoUsesDbsc?: boolean;
    readonly ssoUsesAttestation?: boolean;
    readonly ssoRequestHeaders?: Readonly<Record<string, string>>;
    readonly webSessionRequestHeaders?: Readonly<Record<string, string>>;
    readonly requestHeaders: Readonly<Record<string, string>>;
  };
  readonly assets: readonly AssetRecord[];
  readonly localStorage: Readonly<Record<string, string>>;
  readonly sessionStorage?: Readonly<Record<string, string>>;
  readonly messaging?: MessagingStateExport;
  readonly indexedDb: IndexedDbSnapshot;
}
