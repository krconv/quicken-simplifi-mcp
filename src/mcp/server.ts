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
      limit: z.number().int().min(1).max(200).optional(),
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
      limit: z.number().int().min(1).max(200).optional(),
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
      patch: z.record(z.any()),
    },
    async (input: any) => {
      const result = await toolService.updateTransaction(input);
      return toToolResponse(result);
    },
  );

  return server;
}
