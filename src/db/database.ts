import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import type {
  SimplifiTokenRow,
  SimplifiTokenSet,
  SyncState,
  Transaction,
  TransactionFilters,
  TransactionPage,
} from "../types.js";
import { decodeCursor, encodeCursor, nowIso, sha256Base64Url } from "../utils.js";

export interface TransactionQuery extends TransactionFilters {
  cursor?: string;
  limit: number;
}

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: string;
}

export interface AuthorizationCodeRow {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: string;
  consumedAt?: string;
  createdAt: string;
}

export interface RefreshTokenRecord {
  token: string;
  clientId: string;
  scope?: string;
  expiresAt: string;
}

export interface RefreshTokenRow {
  tokenHash: string;
  clientId: string;
  scope?: string;
  expiresAt: string;
  revokedAt?: string;
  createdAt: string;
}

interface TransactionRow {
  raw_json: string;
}

interface CountRow {
  count: number;
}

export class DatabaseContext {
  private readonly db: any;

  public constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  public close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS simplifi_tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_token TEXT NOT NULL,
        access_token_expires_at TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        refresh_token_expires_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        date_on_after TEXT,
        last_as_of TEXT,
        last_full_sync_at TEXT,
        last_sync_at TEXT,
        sync_status TEXT,
        last_error TEXT
      );

      INSERT OR IGNORE INTO sync_state (id) VALUES (1);

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        posted_on TEXT,
        modified_at TEXT,
        user_modified_at TEXT,
        account_id TEXT,
        payee TEXT,
        renamed_payee TEXT,
        memo TEXT,
        ml_inferred_payee TEXT,
        amount REAL,
        state TEXT,
        known_category_id TEXT,
        coa_type TEXT,
        coa_id TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT NOT NULL,
        cached_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_posted_on ON transactions (posted_on DESC);
      CREATE INDEX IF NOT EXISTS idx_transactions_modified_at ON transactions (modified_at DESC);
      CREATE INDEX IF NOT EXISTS idx_transactions_account_id ON transactions (account_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_payee ON transactions (payee);
      CREATE INDEX IF NOT EXISTS idx_transactions_amount ON transactions (amount);

      CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scope TEXT,
        code_challenge TEXT,
        code_challenge_method TEXT,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        scope TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  public getSimplifiTokens(): SimplifiTokenRow | null {
    const row = this.db
      .prepare(
        `
          SELECT
            access_token,
            access_token_expires_at,
            refresh_token,
            refresh_token_expires_at,
            updated_at
          FROM simplifi_tokens
          WHERE id = 1
        `,
      )
      .get() as
      | {
          access_token: string;
          access_token_expires_at: string;
          refresh_token: string;
          refresh_token_expires_at: string | null;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      accessToken: row.access_token,
      accessTokenExpiresAt: row.access_token_expires_at,
      refreshToken: row.refresh_token,
      refreshTokenExpiresAt: row.refresh_token_expires_at ?? undefined,
      updatedAt: row.updated_at,
    };
  }

  public saveSimplifiTokens(tokens: SimplifiTokenSet): void {
    this.db
      .prepare(
        `
          INSERT INTO simplifi_tokens (
            id,
            access_token,
            access_token_expires_at,
            refresh_token,
            refresh_token_expires_at,
            updated_at
          ) VALUES (1, @accessToken, @accessTokenExpiresAt, @refreshToken, @refreshTokenExpiresAt, @updatedAt)
          ON CONFLICT(id) DO UPDATE SET
            access_token = excluded.access_token,
            access_token_expires_at = excluded.access_token_expires_at,
            refresh_token = excluded.refresh_token,
            refresh_token_expires_at = excluded.refresh_token_expires_at,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshToken: tokens.refreshToken,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt ?? null,
        updatedAt: nowIso(),
      });
  }

  public getSyncState(): SyncState {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            date_on_after,
            last_as_of,
            last_full_sync_at,
            last_sync_at,
            sync_status,
            last_error
          FROM sync_state
          WHERE id = 1
        `,
      )
      .get() as
      | {
          id: number;
          date_on_after: string | null;
          last_as_of: string | null;
          last_full_sync_at: string | null;
          last_sync_at: string | null;
          sync_status: string | null;
          last_error: string | null;
        }
      | undefined;

    if (!row) {
      return { id: 1 };
    }

    return {
      id: row.id,
      dateOnAfter: row.date_on_after ?? undefined,
      lastAsOf: row.last_as_of ?? undefined,
      lastFullSyncAt: row.last_full_sync_at ?? undefined,
      lastSyncAt: row.last_sync_at ?? undefined,
      syncStatus: row.sync_status ?? undefined,
      lastError: row.last_error ?? undefined,
    };
  }

  public updateSyncState(patch: Partial<SyncState>): void {
    const current = this.getSyncState();
    const next: SyncState = {
      ...current,
      ...patch,
      id: 1,
    };

    this.db
      .prepare(
        `
          UPDATE sync_state
          SET
            date_on_after = @dateOnAfter,
            last_as_of = @lastAsOf,
            last_full_sync_at = @lastFullSyncAt,
            last_sync_at = @lastSyncAt,
            sync_status = @syncStatus,
            last_error = @lastError
          WHERE id = 1
        `,
      )
      .run({
        dateOnAfter: next.dateOnAfter ?? null,
        lastAsOf: next.lastAsOf ?? null,
        lastFullSyncAt: next.lastFullSyncAt ?? null,
        lastSyncAt: next.lastSyncAt ?? null,
        syncStatus: next.syncStatus ?? null,
        lastError: next.lastError ?? null,
      });
  }

  public upsertTransactions(transactions: Transaction[]): void {
    if (transactions.length === 0) {
      return;
    }

    const statement = this.db.prepare(`
      INSERT INTO transactions (
        id,
        posted_on,
        modified_at,
        user_modified_at,
        account_id,
        payee,
        renamed_payee,
        memo,
        ml_inferred_payee,
        amount,
        state,
        known_category_id,
        coa_type,
        coa_id,
        is_deleted,
        raw_json,
        cached_at
      ) VALUES (
        @id,
        @postedOn,
        @modifiedAt,
        @userModifiedAt,
        @accountId,
        @payee,
        @renamedPayee,
        @memo,
        @mlInferredPayee,
        @amount,
        @state,
        @knownCategoryId,
        @coaType,
        @coaId,
        @isDeleted,
        @rawJson,
        @cachedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        posted_on = excluded.posted_on,
        modified_at = excluded.modified_at,
        user_modified_at = excluded.user_modified_at,
        account_id = excluded.account_id,
        payee = excluded.payee,
        renamed_payee = excluded.renamed_payee,
        memo = excluded.memo,
        ml_inferred_payee = excluded.ml_inferred_payee,
        amount = excluded.amount,
        state = excluded.state,
        known_category_id = excluded.known_category_id,
        coa_type = excluded.coa_type,
        coa_id = excluded.coa_id,
        is_deleted = excluded.is_deleted,
        raw_json = excluded.raw_json,
        cached_at = excluded.cached_at
    `);

    const run = this.db.transaction((items: Transaction[]) => {
      const cachedAt = nowIso();
      for (const item of items) {
        statement.run({
          id: item.id,
          postedOn: typeof item.postedOn === "string" ? item.postedOn : null,
          modifiedAt: typeof item.modifiedAt === "string" ? item.modifiedAt : null,
          userModifiedAt: typeof item.userModifiedAt === "string" ? item.userModifiedAt : null,
          accountId: typeof item.accountId === "string" ? item.accountId : null,
          payee: typeof item.payee === "string" ? item.payee : null,
          renamedPayee: typeof item.renamedPayee === "string" ? item.renamedPayee : null,
          memo: typeof item.memo === "string" ? item.memo : null,
          mlInferredPayee: typeof item.mlInferredPayee === "string" ? item.mlInferredPayee : null,
          amount: typeof item.amount === "number" ? item.amount : null,
          state: typeof item.state === "string" ? item.state : null,
          knownCategoryId: typeof item.knownCategoryId === "string" ? item.knownCategoryId : null,
          coaType: typeof item.coa?.type === "string" ? item.coa.type : null,
          coaId: typeof item.coa?.id === "string" ? item.coa.id : null,
          isDeleted: item.isDeleted ? 1 : 0,
          rawJson: JSON.stringify(item),
          cachedAt,
        });
      }
    });

    run(transactions);
  }

  public getTransactionById(id: string): Transaction | null {
    const row = this.db.prepare(`SELECT raw_json FROM transactions WHERE id = ?`).get(id) as TransactionRow | undefined;
    if (!row) {
      return null;
    }

    return JSON.parse(row.raw_json) as Transaction;
  }

  public listTransactions(query: TransactionQuery): TransactionPage {
    return this.queryTransactions({
      query,
      searchTerm: undefined,
    });
  }

  public searchTransactions(query: TransactionQuery & { searchTerm: string }): TransactionPage {
    return this.queryTransactions({
      query,
      searchTerm: query.searchTerm,
    });
  }

  private queryTransactions(args: { query: TransactionQuery; searchTerm?: string }): TransactionPage {
    const offset = decodeCursor(args.query.cursor);
    const limit = Math.min(Math.max(args.query.limit, 1), 200);

    const where: string[] = [];
    const values: unknown[] = [];

    if (args.query.accountId) {
      where.push("account_id = ?");
      values.push(args.query.accountId);
    }

    if (args.query.dateFrom) {
      where.push("posted_on >= ?");
      values.push(args.query.dateFrom);
    }

    if (args.query.dateTo) {
      where.push("posted_on <= ?");
      values.push(args.query.dateTo);
    }

    if (typeof args.query.minAmount === "number") {
      where.push("amount >= ?");
      values.push(args.query.minAmount);
    }

    if (typeof args.query.maxAmount === "number") {
      where.push("amount <= ?");
      values.push(args.query.maxAmount);
    }

    if (!args.query.includeDeleted) {
      where.push("is_deleted = 0");
    }

    if (args.searchTerm && args.searchTerm.trim().length > 0) {
      where.push(
        `(LOWER(payee) LIKE ? OR LOWER(renamed_payee) LIKE ? OR LOWER(memo) LIKE ? OR LOWER(ml_inferred_payee) LIKE ?)`,
      );
      const like = `%${args.searchTerm.toLowerCase()}%`;
      values.push(like, like, like, like);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM transactions ${whereClause}`).get(...values) as CountRow)
      .count;

    const sql = `
      SELECT raw_json
      FROM transactions
      ${whereClause}
      ORDER BY posted_on DESC, id DESC
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(sql).all(...values, limit + 1, offset) as TransactionRow[];
    const hasNext = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => JSON.parse(row.raw_json) as Transaction);

    return {
      items,
      total,
      nextCursor: hasNext ? encodeCursor(offset + limit) : undefined,
    };
  }

  public saveAuthorizationCode(record: AuthorizationCodeRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO oauth_authorization_codes (
            code_hash,
            client_id,
            redirect_uri,
            scope,
            code_challenge,
            code_challenge_method,
            expires_at,
            consumed_at,
            created_at
          ) VALUES (
            @codeHash,
            @clientId,
            @redirectUri,
            @scope,
            @codeChallenge,
            @codeChallengeMethod,
            @expiresAt,
            NULL,
            @createdAt
          )
        `,
      )
      .run({
        codeHash: sha256Base64Url(record.code),
        clientId: record.clientId,
        redirectUri: record.redirectUri,
        scope: record.scope ?? null,
        codeChallenge: record.codeChallenge ?? null,
        codeChallengeMethod: record.codeChallengeMethod ?? null,
        expiresAt: record.expiresAt,
        createdAt: nowIso(),
      });
  }

  public consumeAuthorizationCode(code: string): AuthorizationCodeRow | null {
    const codeHash = sha256Base64Url(code);

    const row = this.db
      .prepare(
        `
          SELECT
            code_hash,
            client_id,
            redirect_uri,
            scope,
            code_challenge,
            code_challenge_method,
            expires_at,
            consumed_at,
            created_at
          FROM oauth_authorization_codes
          WHERE code_hash = ?
        `,
      )
      .get(codeHash) as
      | {
          code_hash: string;
          client_id: string;
          redirect_uri: string;
          scope: string | null;
          code_challenge: string | null;
          code_challenge_method: string | null;
          expires_at: string;
          consumed_at: string | null;
          created_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    if (row.consumed_at !== null) {
      return null;
    }

    this.db
      .prepare(`UPDATE oauth_authorization_codes SET consumed_at = ? WHERE code_hash = ?`)
      .run(nowIso(), codeHash);

    return {
      codeHash: row.code_hash,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      scope: row.scope ?? undefined,
      codeChallenge: row.code_challenge ?? undefined,
      codeChallengeMethod: row.code_challenge_method ?? undefined,
      expiresAt: row.expires_at,
      consumedAt: undefined,
      createdAt: row.created_at,
    };
  }

  public saveRefreshToken(record: RefreshTokenRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO oauth_refresh_tokens (
            token_hash,
            client_id,
            scope,
            expires_at,
            revoked_at,
            created_at
          ) VALUES (
            @tokenHash,
            @clientId,
            @scope,
            @expiresAt,
            NULL,
            @createdAt
          )
        `,
      )
      .run({
        tokenHash: sha256Base64Url(record.token),
        clientId: record.clientId,
        scope: record.scope ?? null,
        expiresAt: record.expiresAt,
        createdAt: nowIso(),
      });
  }

  public getRefreshToken(token: string): RefreshTokenRow | null {
    const row = this.db
      .prepare(
        `
          SELECT
            token_hash,
            client_id,
            scope,
            expires_at,
            revoked_at,
            created_at
          FROM oauth_refresh_tokens
          WHERE token_hash = ?
        `,
      )
      .get(sha256Base64Url(token)) as
      | {
          token_hash: string;
          client_id: string;
          scope: string | null;
          expires_at: string;
          revoked_at: string | null;
          created_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      tokenHash: row.token_hash,
      clientId: row.client_id,
      scope: row.scope ?? undefined,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at ?? undefined,
      createdAt: row.created_at,
    };
  }

  public revokeRefreshToken(token: string): void {
    this.db
      .prepare(`UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE token_hash = ?`)
      .run(nowIso(), sha256Base64Url(token));
  }
}
