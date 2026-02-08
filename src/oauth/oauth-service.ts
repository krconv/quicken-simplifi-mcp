import jwt from "jsonwebtoken";

import type { AppConfig } from "../config.js";
import { DatabaseContext } from "../db/database.js";
import { randomToken, sha256Base64Url } from "../utils.js";

export interface AuthorizeRequest {
  responseType: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  scope?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

interface TokenResponse {
  token_type: string;
  access_token: string;
  expires_in: number;
  refresh_token: string;
  scope?: string;
}

interface AccessTokenClaims {
  sub: string;
  client_id: string;
  scope?: string;
}

interface TokenEndpointAuthorizationCodeRequest {
  grant_type: "authorization_code";
  code: string;
  redirect_uri: string;
  client_id: string;
  code_verifier?: string;
}

interface TokenEndpointRefreshRequest {
  grant_type: "refresh_token";
  refresh_token: string;
  client_id?: string;
}

type TokenEndpointRequest = TokenEndpointAuthorizationCodeRequest | TokenEndpointRefreshRequest;

export class OAuthService {
  public constructor(
    private readonly config: AppConfig["oauth"],
    private readonly db: DatabaseContext,
  ) {}

  public getMetadata(baseUrl: string): Record<string, unknown> {
    return {
      issuer: this.config.issuer,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      scopes_supported: ["mcp:read", "mcp:write"],
    };
  }

  public parseAuthorizeRequest(raw: Record<string, unknown>): AuthorizeRequest {
    const responseType = this.getString(raw.response_type, "response_type");
    const clientId = this.getString(raw.client_id, "client_id");
    const redirectUri = this.getString(raw.redirect_uri, "redirect_uri");

    if (responseType !== "code") {
      throw new Error("Only response_type=code is supported");
    }

    if (!this.isRedirectUriAllowed(redirectUri)) {
      throw new Error(`redirect_uri is not allowed: ${redirectUri}`);
    }

    const scope = this.optionalString(raw.scope);
    const state = this.optionalString(raw.state);
    const codeChallenge = this.optionalString(raw.code_challenge);
    const codeChallengeMethod = this.optionalString(raw.code_challenge_method);

    return {
      responseType,
      clientId,
      redirectUri,
      scope,
      state,
      codeChallenge,
      codeChallengeMethod,
    };
  }

  public validateLogin(username: string, password: string): boolean {
    return username === this.config.loginUsername && password === this.config.loginPassword;
  }

  public issueAuthorizationCode(request: AuthorizeRequest): string {
    const code = randomToken(32);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    this.db.saveAuthorizationCode({
      code,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      scope: request.scope,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      expiresAt,
    });

    return code;
  }

  public buildAuthorizeRedirect(request: AuthorizeRequest, code: string): string {
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set("code", code);

    if (request.state) {
      redirect.searchParams.set("state", request.state);
    }

    return redirect.toString();
  }

  public buildAuthorizePage(request: AuthorizeRequest, errorMessage?: string): string {
    const hidden = {
      response_type: request.responseType,
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      state: request.state,
      scope: request.scope,
      code_challenge: request.codeChallenge,
      code_challenge_method: request.codeChallengeMethod,
    };

    const hiddenInputs = Object.entries(hidden)
      .filter(([, value]) => value !== undefined)
      .map(
        ([key, value]) =>
          `<input type="hidden" name="${this.escapeHtml(key)}" value="${this.escapeHtml(String(value))}" />`,
      )
      .join("\n");

    const errorSection = errorMessage
      ? `<p style="color:#b91c1c;font-size:14px;">${this.escapeHtml(errorMessage)}</p>`
      : "";

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Simplifi MCP Login</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
  </head>
  <body style="font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f8fafc;margin:0;padding:32px;">
    <main style="max-width:420px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;">
      <h1 style="margin:0 0 8px 0;font-size:20px;">Authorize MCP Access</h1>
      <p style="margin:0 0 16px 0;color:#475569;font-size:14px;">Sign in to authorize this client to use your Simplifi MCP server.</p>
      ${errorSection}
      <form method="POST" action="/oauth/authorize">
        ${hiddenInputs}
        <label style="display:block;margin:0 0 8px 0;font-size:13px;color:#334155;">Username</label>
        <input type="text" name="username" required style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:12px;" />
        <label style="display:block;margin:0 0 8px 0;font-size:13px;color:#334155;">Password</label>
        <input type="password" name="password" required style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:16px;" />
        <button type="submit" style="width:100%;padding:10px 12px;border:0;border-radius:8px;background:#0f766e;color:white;font-weight:600;cursor:pointer;">Authorize</button>
      </form>
    </main>
  </body>
</html>`;
  }

  public exchangeToken(raw: Record<string, unknown>): TokenResponse {
    const grantType = this.getString(raw.grant_type, "grant_type");

    if (grantType === "authorization_code") {
      return this.exchangeAuthorizationCode({
        grant_type: "authorization_code",
        code: this.getString(raw.code, "code"),
        redirect_uri: this.getString(raw.redirect_uri, "redirect_uri"),
        client_id: this.getString(raw.client_id, "client_id"),
        code_verifier: this.optionalString(raw.code_verifier),
      });
    }

    if (grantType === "refresh_token") {
      return this.exchangeRefreshToken({
        grant_type: "refresh_token",
        refresh_token: this.getString(raw.refresh_token, "refresh_token"),
        client_id: this.optionalString(raw.client_id),
      });
    }

    throw new Error(`Unsupported grant_type: ${grantType}`);
  }

  private exchangeAuthorizationCode(input: TokenEndpointAuthorizationCodeRequest): TokenResponse {
    const code = this.db.consumeAuthorizationCode(input.code);
    if (!code) {
      throw new Error("Invalid authorization code");
    }

    if (code.redirectUri !== input.redirect_uri || code.clientId !== input.client_id) {
      throw new Error("Authorization code does not match client or redirect_uri");
    }

    if (new Date(code.expiresAt).getTime() <= Date.now()) {
      throw new Error("Authorization code expired");
    }

    if (code.codeChallenge) {
      if (!input.code_verifier) {
        throw new Error("Missing code_verifier for PKCE-protected authorization code");
      }

      const method = code.codeChallengeMethod ?? "plain";
      const computed = method === "S256" ? sha256Base64Url(input.code_verifier) : input.code_verifier;

      if (computed !== code.codeChallenge) {
        throw new Error("PKCE code_verifier validation failed");
      }
    }

    return this.issueTokenPair({
      clientId: code.clientId,
      scope: code.scope,
    });
  }

  private exchangeRefreshToken(input: TokenEndpointRefreshRequest): TokenResponse {
    const refreshToken = this.db.getRefreshToken(input.refresh_token);
    if (!refreshToken) {
      throw new Error("Invalid refresh_token");
    }

    if (refreshToken.revokedAt) {
      throw new Error("Refresh token has been revoked");
    }

    if (new Date(refreshToken.expiresAt).getTime() <= Date.now()) {
      throw new Error("Refresh token expired");
    }

    if (input.client_id && input.client_id !== refreshToken.clientId) {
      throw new Error("refresh_token client_id mismatch");
    }

    this.db.revokeRefreshToken(input.refresh_token);

    return this.issueTokenPair({
      clientId: refreshToken.clientId,
      scope: refreshToken.scope,
    });
  }

  private issueTokenPair(params: { clientId: string; scope?: string }): TokenResponse {
    const accessPayload: AccessTokenClaims = {
      sub: this.config.loginUsername,
      client_id: params.clientId,
      scope: params.scope,
    };

    const accessToken = jwt.sign(accessPayload, this.config.jwtSecret, {
      algorithm: "HS256",
      issuer: this.config.issuer,
      audience: this.config.audience,
      expiresIn: this.config.accessTokenTtlSeconds,
    });

    const refreshToken = randomToken(48);
    const refreshExpiresAt = new Date(Date.now() + this.config.refreshTokenTtlSeconds * 1000).toISOString();

    this.db.saveRefreshToken({
      token: refreshToken,
      clientId: params.clientId,
      scope: params.scope,
      expiresAt: refreshExpiresAt,
    });

    return {
      token_type: "Bearer",
      access_token: accessToken,
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: params.scope,
    };
  }

  public verifyAccessToken(token: string): AccessTokenClaims {
    const payload = jwt.verify(token, this.config.jwtSecret, {
      algorithms: ["HS256"],
      issuer: this.config.issuer,
      audience: this.config.audience,
    });

    if (typeof payload === "string") {
      throw new Error("Unexpected JWT payload format");
    }

    if (typeof payload.sub !== "string" || typeof payload.client_id !== "string") {
      throw new Error("Access token payload is missing required claims");
    }

    return {
      sub: payload.sub,
      client_id: payload.client_id,
      scope: typeof payload.scope === "string" ? payload.scope : undefined,
    };
  }

  private getString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Missing or invalid field: ${fieldName}`);
    }
    return value;
  }

  private optionalString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    return value.length > 0 ? value : undefined;
  }

  private isRedirectUriAllowed(uri: string): boolean {
    if (this.config.allowedRedirectUris.length === 0) {
      return true;
    }

    return this.config.allowedRedirectUris.includes(uri);
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
}
