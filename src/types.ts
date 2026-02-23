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

export interface Category {
  id?: string;
  parentId?: string;
  categoryType?: string;
  usageType?: string;
  name?: string;
  description?: string;
  createdAt?: string;
  modifiedAt?: string;
  isBusiness?: boolean;
  isInvestment?: boolean;
  isNotEditable?: boolean;
  isNotUserAssignable?: boolean;
  isExcludedFromBudgets?: boolean;
  isExcludedFromCategoryList?: boolean;
  isExcludedFromReports?: boolean;
  [key: string]: unknown;
}

export interface Tag {
  id?: string;
  name?: string;
  type?: string;
  createdAt?: string;
  modifiedAt?: string;
  userModifiedAt?: string;
  numberOfUses?: number;
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

export interface CategoryListResponse {
  metaData: MetaData;
  resources: Category[];
}

export interface TagListResponse {
  metaData: MetaData;
  resources: Tag[];
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
