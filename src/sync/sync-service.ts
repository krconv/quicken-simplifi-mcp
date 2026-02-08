import type { AppConfig } from "../config.js";
import { DatabaseContext } from "../db/database.js";
import { logError, logInfo } from "../logger.js";
import { nowIso } from "../utils.js";
import { SimplifiClient } from "../simplifi/client.js";

export interface SyncResult {
  mode: "full" | "incremental" | "noop";
  pages: number;
  transactions: number;
  asOf?: string;
}

export class SyncService {
  private intervalHandle: NodeJS.Timeout | null = null;
  private activeSync: Promise<SyncResult> | null = null;

  public constructor(
    private readonly config: AppConfig["simplifi"],
    private readonly db: DatabaseContext,
    private readonly client: SimplifiClient,
  ) {}

  public start(): void {
    if (this.intervalHandle) {
      return;
    }

    this.intervalHandle = setInterval(() => {
      void this.syncIncremental().catch((error: unknown) => {
        logError("Background incremental sync failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.config.syncIntervalMs);
  }

  public stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  public async ensureInitialized(): Promise<SyncResult> {
    const state = this.db.getSyncState();
    if (state.lastFullSyncAt) {
      return { mode: "noop", pages: 0, transactions: 0, asOf: state.lastAsOf };
    }

    return this.syncFull();
  }

  public async ensureFresh(maxAgeMs: number): Promise<SyncResult> {
    const state = this.db.getSyncState();
    if (!state.lastSyncAt) {
      return this.syncFull();
    }

    const ageMs = Date.now() - new Date(state.lastSyncAt).getTime();
    if (ageMs <= maxAgeMs) {
      return { mode: "noop", pages: 0, transactions: 0, asOf: state.lastAsOf };
    }

    return this.syncIncremental();
  }

  public async syncFull(): Promise<SyncResult> {
    return this.withLock(() => this.doFullSync());
  }

  public async syncIncremental(): Promise<SyncResult> {
    return this.withLock(() => this.doIncrementalSync());
  }

  private async doFullSync(): Promise<SyncResult> {
    this.db.updateSyncState({ syncStatus: "running", lastError: undefined });

    try {
      let dateOnAfter = this.db.getSyncState().dateOnAfter;
      if (!dateOnAfter) {
        const earliest = await this.client.getEarliestDateOn([]);
        dateOnAfter = earliest.dateOn;
      }

      let nextLink: string | undefined;
      let pages = 0;
      let txCount = 0;
      let latestAsOf: string | undefined;

      do {
        const payload = nextLink
          ? await this.client.listTransactionsFromNextLink(nextLink)
          : await this.client.listTransactions({
              limit: this.config.pageLimit,
              dateOnAfter,
            });

        pages += 1;
        txCount += payload.resources.length;
        this.db.upsertTransactions(payload.resources);

        latestAsOf = payload.metaData.asOf ?? latestAsOf;
        nextLink = payload.metaData.nextLink;
      } while (nextLink);

      const timestamp = nowIso();
      this.db.updateSyncState({
        dateOnAfter,
        lastAsOf: latestAsOf,
        lastFullSyncAt: timestamp,
        lastSyncAt: timestamp,
        syncStatus: "ok",
        lastError: undefined,
      });

      logInfo("Completed full Simplifi transaction sync", {
        pages,
        transactions: txCount,
        asOf: latestAsOf,
      });

      return {
        mode: "full",
        pages,
        transactions: txCount,
        asOf: latestAsOf,
      };
    } catch (error) {
      this.db.updateSyncState({
        syncStatus: "error",
        lastError: error instanceof Error ? error.message : String(error),
        lastSyncAt: nowIso(),
      });
      throw error;
    }
  }

  private async doIncrementalSync(): Promise<SyncResult> {
    const state = this.db.getSyncState();
    if (!state.lastAsOf) {
      return this.doFullSync();
    }

    this.db.updateSyncState({ syncStatus: "running", lastError: undefined });

    try {
      let nextLink: string | undefined;
      let pages = 0;
      let txCount = 0;
      let latestAsOf: string | undefined = state.lastAsOf;

      do {
        const payload = nextLink
          ? await this.client.listTransactionsFromNextLink(nextLink)
          : await this.client.listTransactions({
              limit: this.config.pageLimit,
              modifiedAfter: state.lastAsOf,
              dateOnAfter: state.dateOnAfter,
            });

        pages += 1;
        txCount += payload.resources.length;
        this.db.upsertTransactions(payload.resources);

        latestAsOf = payload.metaData.asOf ?? latestAsOf;
        nextLink = payload.metaData.nextLink;
      } while (nextLink);

      this.db.updateSyncState({
        lastAsOf: latestAsOf,
        lastSyncAt: nowIso(),
        syncStatus: "ok",
        lastError: undefined,
      });

      return {
        mode: "incremental",
        pages,
        transactions: txCount,
        asOf: latestAsOf,
      };
    } catch (error) {
      this.db.updateSyncState({
        syncStatus: "error",
        lastError: error instanceof Error ? error.message : String(error),
        lastSyncAt: nowIso(),
      });
      throw error;
    }
  }

  private async withLock(work: () => Promise<SyncResult>): Promise<SyncResult> {
    if (this.activeSync) {
      return this.activeSync;
    }

    this.activeSync = work().finally(() => {
      this.activeSync = null;
    });

    return this.activeSync;
  }
}
