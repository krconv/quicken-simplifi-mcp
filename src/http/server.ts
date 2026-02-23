import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { AppConfig } from "../config.js";
import { logInfo, logWarn } from "../logger.js";
import { createMcpServer } from "../mcp/server.js";
import { OAuthService } from "../oauth/oauth-service.js";
import { SimplifiAuthService } from "../simplifi/auth-service.js";
import { TransactionToolService } from "../services/transaction-tool-service.js";

interface HttpServerDeps {
  config: AppConfig;
  oauthService: OAuthService;
  simplifiAuthService: SimplifiAuthService;
  toolService: TransactionToolService;
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

export async function startHttpServer(deps: HttpServerDeps): Promise<RunningHttpServer> {
  const { config, oauthService, simplifiAuthService, toolService } = deps;

  const app = express();
  const sessions = new Map<string, StreamableHTTPServerTransport>();

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

  app.post("/oauth/register", (req, res) => {
    const response = oauthService.buildClientRegistrationResponse(toRecord(req.body), config.server.publicBaseUrl);
    res.status(201).json(response);
  });

  app.post("/oauth/authorize", async (req, res) => {
    try {
      const request = oauthService.parseAuthorizeRequest(toRecord(req.body));
      const username = typeof req.body.username === "string" ? req.body.username : "";
      const password = typeof req.body.password === "string" ? req.body.password : "";

      if (!oauthService.validateLogin(username, password)) {
        res.status(401).type("html").send(oauthService.buildAuthorizePage(request, "Invalid credentials"));
        return;
      }

      const result = await simplifiAuthService.attemptLogin();

      if (result.status === "mfa_required") {
        res
          .status(200)
          .type("html")
          .send(oauthService.buildMfaPage(request, result.pendingId, result));
        return;
      }

      const code = oauthService.issueAuthorizationCode(request);
      const redirect = oauthService.buildAuthorizeRedirect(request, code);
      res.redirect(302, redirect);
    } catch (error) {
      res.status(400).type("text/plain").send(error instanceof Error ? error.message : "Invalid authorize request");
    }
  });

  app.post("/oauth/mfa", async (req, res) => {
    try {
      const request = oauthService.parseAuthorizeRequest(toRecord(req.body));
      const pendingId = typeof req.body.pending_mfa_id === "string" ? req.body.pending_mfa_id : "";
      const mfaCode = typeof req.body.mfa_code === "string" ? req.body.mfa_code.trim() : "";

      if (!pendingId || !mfaCode) {
        res.status(400).type("text/plain").send("Missing pending_mfa_id or mfa_code");
        return;
      }

      try {
        await simplifiAuthService.completeMfaLogin(pendingId, mfaCode);
      } catch (mfaError) {
        const mfaInfo = simplifiAuthService.getPendingMfaInfo(pendingId) ?? {
          mfaChannel: "EMAIL",
        };
        res
          .status(200)
          .type("html")
          .send(
            oauthService.buildMfaPage(
              request,
              pendingId,
              mfaInfo,
              mfaError instanceof Error ? mfaError.message : "Verification failed. Please try again.",
            ),
          );
        return;
      }

      const code = oauthService.issueAuthorizationCode(request);
      const redirect = oauthService.buildAuthorizeRedirect(request, code);
      res.redirect(302, redirect);
    } catch (error) {
      res.status(400).type("text/plain").send(error instanceof Error ? error.message : "Invalid MFA request");
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

  // Handle all MCP requests (GET for SSE, POST for JSON-RPC, DELETE for session close).
  // A new McpServer+transport pair is created per session; the transport itself validates
  // session IDs and whether the first request is an initialize — no manual pre-checks needed.
  app.all("/mcp", requireAccessToken, async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    let transport = sessionId ? sessions.get(sessionId) : undefined;

    try {
      if (!transport) {
        const mcpServer = createMcpServer(toolService);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            sessions.set(newSessionId, transport!);
          },
        });

        transport.onclose = () => {
          if (transport!.sessionId) {
            sessions.delete(transport!.sessionId);
          }
        };

        await mcpServer.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logWarn("Error handling /mcp request", {
        error: error instanceof Error ? error.message : String(error),
        method: req.method,
      });

      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error", error_description: "Failed to handle MCP request" });
      }
    }
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
