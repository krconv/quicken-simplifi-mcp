import { DatabaseContext, type TransactionQuery } from "../db/database.js";
import type { Transaction, TransactionFilters } from "../types.js";
import { deepMerge } from "../utils.js";
import { SimplifiClient } from "../simplifi/client.js";
import { SyncService } from "../sync/sync-service.js";

export interface ListTransactionsInput extends TransactionFilters {
  limit?: number;
  cursor?: string;
  refresh?: boolean;
}

export interface SearchTransactionsInput extends TransactionFilters {
  query: string;
  limit?: number;
  cursor?: string;
  refresh?: boolean;
}

export interface GetTransactionInput {
  transactionId: string;
  refreshOnMiss?: boolean;
}

export interface UpdateTransactionInput {
  transactionId: string;
  patch: Record<string, unknown>;
}

export class TransactionToolService {
  public constructor(
    private readonly db: DatabaseContext,
    private readonly syncService: SyncService,
    private readonly simplifiClient: SimplifiClient,
    private readonly maxStaleMs: number,
  ) {}

  public async listTransactions(input: ListTransactionsInput): Promise<Record<string, unknown>> {
    await this.maybeRefresh(input.refresh ?? false);

    const page = this.db.listTransactions(this.toQuery(input));
    return {
      total: page.total,
      nextCursor: page.nextCursor,
      items: page.items,
    };
  }

  public async searchTransactions(input: SearchTransactionsInput): Promise<Record<string, unknown>> {
    await this.maybeRefresh(input.refresh ?? false);

    const page = this.db.searchTransactions({
      ...this.toQuery(input),
      searchTerm: input.query,
    });

    return {
      total: page.total,
      nextCursor: page.nextCursor,
      items: page.items,
    };
  }

  public async getTransaction(input: GetTransactionInput): Promise<Record<string, unknown>> {
    await this.syncService.ensureFresh(this.maxStaleMs);

    let transaction = this.db.getTransactionById(input.transactionId);
    if (!transaction && (input.refreshOnMiss ?? true)) {
      await this.syncService.syncIncremental();
      transaction = this.db.getTransactionById(input.transactionId);
    }

    if (!transaction) {
      throw new Error(`Transaction ${input.transactionId} not found in cache`);
    }

    return { transaction };
  }

  public async updateTransaction(input: UpdateTransactionInput): Promise<Record<string, unknown>> {
    await this.syncService.ensureFresh(this.maxStaleMs);

    const current = this.db.getTransactionById(input.transactionId);
    if (!current) {
      await this.syncService.syncIncremental();
    }

    const baseline = this.db.getTransactionById(input.transactionId);
    if (!baseline) {
      throw new Error(`Transaction ${input.transactionId} not found in cache; cannot update`);
    }

    const merged = deepMerge<Transaction>(baseline, input.patch);
    this.assertUpsertRequiredFields(merged);

    const mutation = await this.simplifiClient.updateTransaction(input.transactionId, merged);

    await this.syncService.syncIncremental();
    const updated = this.db.getTransactionById(input.transactionId) ?? merged;

    return {
      mutation,
      transaction: updated,
    };
  }

  private async maybeRefresh(forceRefresh: boolean): Promise<void> {
    if (forceRefresh) {
      await this.syncService.syncIncremental();
      return;
    }

    await this.syncService.ensureFresh(this.maxStaleMs);
  }

  private toQuery(input: {
    limit?: number;
    cursor?: string;
    accountId?: string;
    dateFrom?: string;
    dateTo?: string;
    minAmount?: number;
    maxAmount?: number;
    includeDeleted?: boolean;
  }): TransactionQuery {
    return {
      limit: Math.min(Math.max(input.limit ?? 50, 1), 200),
      cursor: input.cursor,
      accountId: input.accountId,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      minAmount: input.minAmount,
      maxAmount: input.maxAmount,
      includeDeleted: input.includeDeleted,
    };
  }

  private assertUpsertRequiredFields(transaction: Transaction): void {
    const requiredKeys = [
      "id",
      "clientId",
      "accountId",
      "postedOn",
      "payee",
      "coa",
      "amount",
      "state",
      "matchState",
      "source",
      "type",
    ] as const;

    for (const key of requiredKeys) {
      const value = transaction[key];
      if (value === undefined || value === null || value === "") {
        throw new Error(`Updated transaction is missing required upsert field: ${key}`);
      }
    }

    const coa = transaction.coa;
    if (!coa || typeof coa !== "object" || typeof coa.type !== "string" || typeof coa.id !== "string") {
      throw new Error("Updated transaction has invalid coa object");
    }
  }
}
