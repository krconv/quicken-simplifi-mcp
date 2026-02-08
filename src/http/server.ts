import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { AppConfig } from "../config.js";
import { logInfo, logWarn } from "../logger.js";
import { createMcpServer } from "../mcp/server.js";
import { OAuthService } from "../oauth/oauth-service.js";
import { TransactionToolService } from "../services/transaction-tool-service.js";

interface HttpServerDeps {
  config: AppConfig;
  oauthService: OAuthService;
  toolService: TransactionToolService;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  sessionId: string;
}

export interface RunningHttpServer {
  close: () => Promise<void>;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

function readBearerToken(req: Request): string | null {
  const header = req.header("authorization");
  if (!header) {
    return null;
  }

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function isInitializePayload(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }

  const payload = body as Record<string, unknown>;
  return payload.jsonrpc === "2.0" && payload.method === "initialize";
}

export async function startHttpServer(deps: HttpServerDeps): Promise<RunningHttpServer> {
  const { config, oauthService, toolService } = deps;

  const app = express();
  const sessions = new Map<string, McpSession>();

  app.disable("x-powered-by");
  app.use(
    cors({
      origin: config.server.corsOrigin === "*" ? true : config.server.corsOrigin,
      credentials: false,
    }),
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.status(200).json(oauthService.getMetadata(config.server.publicBaseUrl));
  });

  app.get("/.well-known/openid-configuration", (_req, res) => {
    res.status(200).json(oauthService.getMetadata(config.server.publicBaseUrl));
  });

  app.get("/oauth/authorize", (req, res) => {
    try {
      const request = oauthService.parseAuthorizeRequest(toRecord(req.query));
      res.status(200).type("html").send(oauthService.buildAuthorizePage(request));
    } catch (error) {
      res.status(400).type("text/plain").send(error instanceof Error ? error.message : "Invalid authorize request");
    }
  });

  app.post("/oauth/authorize", (req, res) => {
    try {
      const request = oauthService.parseAuthorizeRequest(toRecord(req.body));
      const username = typeof req.body.username === "string" ? req.body.username : "";
      const password = typeof req.body.password === "string" ? req.body.password : "";

      if (!oauthService.validateLogin(username, password)) {
        res.status(401).type("html").send(oauthService.buildAuthorizePage(request, "Invalid credentials"));
        return;
      }

      const code = oauthService.issueAuthorizationCode(request);
      const redirect = oauthService.buildAuthorizeRedirect(request, code);
      res.redirect(302, redirect);
    } catch (error) {
      res.status(400).type("text/plain").send(error instanceof Error ? error.message : "Invalid authorize request");
    }
  });

  app.post("/oauth/token", (req, res) => {
    try {
      const payload = oauthService.exchangeToken(toRecord(req.body));
      res.status(200).json(payload);
    } catch (error) {
      res.status(400).json({
        error: "invalid_request",
        error_description: error instanceof Error ? error.message : "Token request failed",
      });
    }
  });

  const requireAccessToken = (req: Request, res: Response, next: NextFunction): void => {
    const token = readBearerToken(req);
    if (!token) {
      res.status(401).json({ error: "invalid_token", error_description: "Missing bearer token" });
      return;
    }

    try {
      oauthService.verifyAccessToken(token);
      next();
    } catch (error) {
      res.status(401).json({
        error: "invalid_token",
        error_description: error instanceof Error ? error.message : "Token verification failed",
      });
    }
  };

  app.post("/mcp", requireAccessToken, async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    try {
      if (existing) {
        await (existing.transport as any).handleRequest(req, res, req.body);
        return;
      }

      if (sessionId) {
        res.status(404).json({ error: "invalid_session", error_description: "Session not found" });
        return;
      }

      if (!isInitializePayload(req.body)) {
        res.status(400).json({ error: "invalid_request", error_description: "Expected initialize request" });
        return;
      }

      const mcpServer = createMcpServer(toolService);
      let boundSessionId = "";
      const transport = new StreamableHTTPServerTransport(
        {
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            boundSessionId = newSessionId;
            sessions.set(newSessionId, { transport, sessionId: newSessionId });
          },
        } as any,
      );

      (transport as any).onclose = async () => {
        if (boundSessionId) {
          sessions.delete(boundSessionId);
        }
      };

      await mcpServer.connect(transport);
      await (transport as any).handleRequest(req, res, req.body);
    } catch (error) {
      logWarn("Error handling POST /mcp", {
        error: error instanceof Error ? error.message : String(error),
      });

      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error", error_description: "Failed to handle MCP request" });
      }
    }
  });

  const handleSessionRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.header("mcp-session-id");
    if (!sessionId) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing mcp-session-id header" });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "invalid_session", error_description: "Session not found" });
      return;
    }

    try {
      await (session.transport as any).handleRequest(req, res);
    } catch (error) {
      logWarn("Error handling MCP session request", {
        error: error instanceof Error ? error.message : String(error),
        method: req.method,
      });

      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error", error_description: "Failed to handle MCP request" });
      }
    }
  };

  app.get("/mcp", requireAccessToken, async (req, res) => {
    await handleSessionRequest(req, res);
  });

  app.delete("/mcp", requireAccessToken, async (req, res) => {
    await handleSessionRequest(req, res);
  });

  app.get("/", (_req, res) => {
    res.status(200).json({
      name: "quicken-simplifi-mcp",
      status: "ok",
      mcp: `${config.server.publicBaseUrl}/mcp`,
      oauthAuthorize: `${config.server.publicBaseUrl}/oauth/authorize`,
      oauthToken: `${config.server.publicBaseUrl}/oauth/token`,
    });
  });

  const server = app.listen(config.server.port, config.server.host);
  await new Promise<void>((resolve) => {
    server.once("listening", () => resolve());
  });

  const address = server.address() as AddressInfo;
  logInfo("HTTP server started", {
    host: address.address,
    port: address.port,
  });

  return {
    close: async () => {
      for (const [sessionId] of sessions.entries()) {
        sessions.delete(sessionId);
      }

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
