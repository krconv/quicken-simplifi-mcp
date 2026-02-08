export interface MetaData {
  asOf?: string;
  currentPage?: number;
  lastRefId?: string;
  limit?: number;
  nextLink?: string;
  offset?: number;
  pageSize?: number;
  totalPages?: number;
  totalSize?: number;
  [key: string]: unknown;
}

export interface CoaRef {
  type?: string;
  id?: string;
  [key: string]: unknown;
}

export interface Transaction {
  id: string;
  clientId?: string;
  userModifiedAt?: string;
  createdAt?: string;
  modifiedAt?: string;
  dbVersion?: number;
  source?: string;
  accountId?: string;
  postedOn?: string;
  payee?: string;
  renamedPayee?: string;
  memo?: string;
  coa?: CoaRef;
  amount?: number;
  state?: string;
  matchState?: string;
  type?: string;
  knownCategoryId?: string;
  mlInferredPayee?: string;
  isDeleted?: boolean;
  [key: string]: unknown;
}

export interface TransactionListResponse {
  metaData: MetaData;
  resources: Transaction[];
}

export interface EarliestDateOnResponse {
  dateOn: string;
  [key: string]: unknown;
}

export interface TransactionMutationResponse {
  clientId?: string;
  id?: string;
  status?: string;
  explanation?: string;
  [key: string]: unknown;
}

export interface SimplifiTokenSet {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt?: string;
}

export interface SimplifiTokenRow extends SimplifiTokenSet {
  updatedAt: string;
}

export interface SyncState {
  id: number;
  dateOnAfter?: string;
  lastAsOf?: string;
  lastFullSyncAt?: string;
  lastSyncAt?: string;
  syncStatus?: string;
  lastError?: string;
}

export interface TransactionFilters {
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
  minAmount?: number;
  maxAmount?: number;
  includeDeleted?: boolean;
}

export interface TransactionPage {
  items: Transaction[];
  total: number;
  nextCursor?: string;
}
