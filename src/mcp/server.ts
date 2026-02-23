import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { TransactionToolService } from "../services/transaction-tool-service.js";

function toToolResponse(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function createMcpServer(toolService: TransactionToolService): McpServer {
  const server = new McpServer({
    name: "quicken-simplifi-mcp",
    version: "0.1.0",
  });
  const mcp = server as any;

  mcp.tool(
    "list_transactions",
    "List locally cached Simplifi transactions with optional filters and pagination.",
    {
      limit: z.coerce.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
      accountId: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      minAmount: z.number().optional(),
      maxAmount: z.number().optional(),
      includeDeleted: z.boolean().optional(),
      refresh: z.boolean().optional(),
    },
    async (input: any) => {
      const result = await toolService.listTransactions(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "search_transactions",
    "Search locally cached Simplifi transactions by text with optional filters.",
    {
      query: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
      accountId: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      minAmount: z.number().optional(),
      maxAmount: z.number().optional(),
      includeDeleted: z.boolean().optional(),
      refresh: z.boolean().optional(),
    },
    async (input: any) => {
      const result = await toolService.searchTransactions(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "get_transaction",
    "Get a single transaction by id from local cache (with sync-on-miss).",
    {
      transactionId: z.string().min(1),
      refreshOnMiss: z.boolean().optional(),
    },
    async (input: any) => {
      const result = await toolService.getTransaction(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "update_transaction",
    "Update a Simplifi transaction by sending a full upsert payload merged from cache + patch.",
    {
      transactionId: z.string().min(1),
      patch: z.preprocess((v) => (typeof v === "string" ? JSON.parse(v) : v), z.record(z.any())),
    },
    async (input: any) => {
      const result = await toolService.updateTransaction(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "categorize_transaction",
    "Convenience wrapper to set a transaction category (sets coa.type=CATEGORY and coa.id=<categoryId>).",
    {
      transactionId: z.string().min(1),
      categoryId: z.string().min(1),
    },
    async (input: any) => {
      const result = await toolService.categorizeTransaction(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "list_uncategorized_transactions",
    "List transactions that look uncategorized (coa.type=UNCATEGORIZED or coa.id=0).",
    {
      limit: z.coerce.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
      accountId: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      minAmount: z.number().optional(),
      maxAmount: z.number().optional(),
      includeDeleted: z.boolean().optional(),
      refresh: z.boolean().optional(),
    },
    async (input: any) => {
      const result = await toolService.listUncategorizedTransactions(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "search_merchants",
    "Search merchants (payee names) from the cached transaction DB and return frequency counts.",
    {
      query: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      includeDeleted: z.boolean().optional(),
    },
    async (input: any) => {
      const result = await toolService.searchMerchants(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "list_categories",
    "List Simplifi categories (synced and cached locally).",
    {
      refresh: z.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional(),
    },
    async (input: any) => {
      const result = await toolService.listCategories(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "search_categories",
    "Search Simplifi categories by name (synced and cached locally).",
    {
      query: z.string().min(1),
      refresh: z.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional(),
    },
    async (input: any) => {
      const result = await toolService.searchCategories(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "list_tags",
    "List Simplifi tags (synced and cached locally).",
    {
      refresh: z.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional(),
    },
    async (input: any) => {
      const result = await toolService.listTags(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "search_tags",
    "Search Simplifi tags by name (synced and cached locally).",
    {
      query: z.string().min(1),
      refresh: z.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional(),
    },
    async (input: any) => {
      const result = await toolService.searchTags(input);
      return toToolResponse(result);
    },
  );

  mcp.tool(
    "suggest_categories_for_merchant",
    "Suggest likely categories for a merchant based on your historical transactions in the local cache.",
    {
      merchant: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(20).optional(),
      matchMode: z.enum(["exact", "contains"]).optional(),
      refreshCategories: z.boolean().optional(),
    },
    async (input: any) => {
      const result = await toolService.suggestCategoriesForMerchant(input);
      return toToolResponse(result);
    },
  );

  return server;
}
