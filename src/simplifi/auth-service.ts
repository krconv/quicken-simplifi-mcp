import { URL } from "node:url";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import { logInfo, logWarn } from "../logger.js";
import type { SimplifiTokenSet } from "../types.js";
import { isExpired, nowIso } from "../utils.js";
import { DatabaseContext } from "../db/database.js";

const AUTHORIZATION_SKEW_MS = 60_000;

export class SimplifiAuthService {
  public constructor(
    private readonly config: AppConfig["simplifi"],
    private readonly db: DatabaseContext,
  ) {}

  public async getAccessToken(): Promise<string> {
    const cached = this.db.getSimplifiTokens();

    if (cached && !isExpired(cached.accessTokenExpiresAt, AUTHORIZATION_SKEW_MS)) {
      return cached.accessToken;
    }

    if (cached?.refreshToken) {
      try {
        const refreshed = await this.refreshToken(cached.refreshToken);
        this.db.saveSimplifiTokens(refreshed);
        return refreshed.accessToken;
      } catch (error) {
        logWarn("Simplifi token refresh failed; attempting credential re-login", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const created = await this.loginWithCredentials();
    this.db.saveSimplifiTokens(created);
    return created.accessToken;
  }

  private async loginWithCredentials(): Promise<SimplifiTokenSet> {
    const authorizeUrl = new URL("/oauth/authorize", this.config.baseUrl);
    const threatMetrixSessionId = this.config.threatMetrixSessionId ?? randomUUID();
    const threatMetrixRequestId = this.config.threatMetrixRequestId ?? null;

    const authorizeResponse = await this.request(authorizeUrl.toString(), {
      method: "POST",
      body: JSON.stringify({
        clientId: this.config.clientId,
        username: this.config.email,
        password: this.config.password,
        redirectUri: this.config.redirectUri,
        responseType: "code",
        mfaChannel: null,
        mfaCode: null,
        threatMetrixRequestId,
        threatMetrixSessionId,
      }),
      headers: {
        "tm-session-id": threatMetrixSessionId,
      },
    });

    if (![200, 201].includes(authorizeResponse.status)) {
      const body = await authorizeResponse.text();
      throw new Error(`Simplifi authorize failed: status=${authorizeResponse.status}, body=${body}`);
    }

    const location = authorizeResponse.headers.get("location");
    if (!location) {
      throw new Error("Simplifi authorize did not return a location header with auth code");
    }

    const codeUrl = new URL(location);
    const code = codeUrl.searchParams.get("code");
    if (!code) {
      throw new Error("Simplifi authorize location header missing authorization code");
    }

    const token = await this.exchangeAuthorizationCode(code);
    logInfo("Simplifi credential login completed");
    return token;
  }

  private async refreshToken(refreshToken: string): Promise<SimplifiTokenSet> {
    const tokenUrl = new URL("/oauth/token", this.config.baseUrl);

    const response = await this.request(tokenUrl.toString(), {
      method: "POST",
      body: JSON.stringify({
        grantType: "refreshToken",
        responseType: "token",
        redirectUri: this.config.redirectUri,
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        refreshToken,
      }),
    });

    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(`Simplifi token refresh failed: status=${response.status}, body=${body}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return this.parseTokenPayload(payload);
  }

  private async exchangeAuthorizationCode(code: string): Promise<SimplifiTokenSet> {
    const tokenUrl = new URL("/oauth/token", this.config.baseUrl);

    const response = await this.request(tokenUrl.toString(), {
      method: "POST",
      body: JSON.stringify({
        grantType: "authorization_code",
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        code,
        redirectUri: this.config.redirectUri,
      }),
    });

    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(`Simplifi token exchange failed: status=${response.status}, body=${body}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return this.parseTokenPayload(payload);
  }

  private parseTokenPayload(payload: Record<string, unknown>): SimplifiTokenSet {
    const accessToken = this.pickString(payload, "accessToken") ?? this.pickString(payload, "access_token");
    const refreshToken = this.pickString(payload, "refreshToken") ?? this.pickString(payload, "refresh_token");

    if (!accessToken || !refreshToken) {
      throw new Error("Simplifi token response did not include access and refresh tokens");
    }

    const accessTokenExpiresAt =
      this.pickString(payload, "accessTokenExpired") ??
      this.calculateExpiryFromSeconds(payload.expires_in) ??
      new Date(Date.now() + 55 * 60 * 1000).toISOString();

    const refreshTokenExpiresAt = this.pickString(payload, "refreshTokenExpired") ?? undefined;

    return {
      accessToken,
      accessTokenExpiresAt,
      refreshToken,
      refreshTokenExpiresAt,
    };
  }

  private pickString(payload: Record<string, unknown>, key: string): string | undefined {
    const value = payload[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private calculateExpiryFromSeconds(value: unknown): string | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return undefined;
    }
    return new Date(Date.now() + value * 1000).toISOString();
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);

    try {
      return await fetch(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "content-type": "application/json;charset=UTF-8",
          accept: "application/json, text/plain, */*",
          "app-client-id": this.config.clientId,
          "app-release": "6.5.0",
          "app-build": "63580",
          ...(init.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  public clearTokens(): void {
    this.db.saveSimplifiTokens({
      accessToken: "",
      accessTokenExpiresAt: nowIso(),
      refreshToken: "",
    });
  }
}
