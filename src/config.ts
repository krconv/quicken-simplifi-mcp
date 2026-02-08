import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  server: {
    host: string;
    port: number;
    publicBaseUrl: string;
    corsOrigin: string;
  };
  cache: {
    dbPath: string;
  };
  oauth: {
    issuer: string;
    audience: string;
    jwtSecret: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    loginUsername: string;
    loginPassword: string;
    allowedRedirectUris: string[];
  };
  simplifi: {
    baseUrl: string;
    email: string;
    password: string;
    datasetId: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    threatMetrixSessionId?: string;
    threatMetrixRequestId?: string;
    httpTimeoutMs: number;
    syncIntervalMs: number;
    maxStaleMs: number;
    pageLimit: number;
  };
}

function getEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric environment variable ${name}: ${raw}`);
  }
  return value;
}

function parseRedirectAllowlist(raw: string): string[] {
  if (!raw.trim()) {
    return [];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function loadConfig(): AppConfig {
  const port = getNumberEnv("PORT", 8787);
  const host = process.env.HOST ?? "0.0.0.0";
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;

  const cacheDbPath = path.resolve(process.cwd(), process.env.CACHE_DB_PATH ?? "./data/cache.sqlite");

  return {
    server: {
      host,
      port,
      publicBaseUrl,
      corsOrigin: process.env.CORS_ORIGIN ?? "*",
    },
    cache: {
      dbPath: cacheDbPath,
    },
    oauth: {
      issuer: process.env.OAUTH_ISSUER ?? publicBaseUrl,
      audience: process.env.OAUTH_AUDIENCE ?? "simplifi-mcp",
      jwtSecret: getEnv("OAUTH_JWT_SECRET"),
      accessTokenTtlSeconds: getNumberEnv("OAUTH_ACCESS_TOKEN_TTL_SECONDS", 900),
      refreshTokenTtlSeconds: getNumberEnv("OAUTH_REFRESH_TOKEN_TTL_SECONDS", 60 * 60 * 24 * 30),
      loginUsername: getEnv("OAUTH_LOGIN_USERNAME"),
      loginPassword: getEnv("OAUTH_LOGIN_PASSWORD"),
      allowedRedirectUris: parseRedirectAllowlist(process.env.OAUTH_ALLOWED_REDIRECT_URIS ?? ""),
    },
    simplifi: {
      baseUrl: process.env.SIMPLIFI_BASE_URL ?? "https://services.quicken.com",
      email: getEnv("SIMPLIFI_EMAIL"),
      password: getEnv("SIMPLIFI_PASSWORD"),
      datasetId: getEnv("SIMPLIFI_DATASET_ID"),
      clientId: process.env.SIMPLIFI_CLIENT_ID ?? "acme_web",
      clientSecret: process.env.SIMPLIFI_CLIENT_SECRET ?? "BCDCxXwdWYcj@bK6",
      redirectUri: process.env.SIMPLIFI_REDIRECT_URI ?? "https://simplifi.quicken.com/login",
      threatMetrixSessionId: process.env.SIMPLIFI_THREAT_METRIX_SESSION_ID,
      threatMetrixRequestId: process.env.SIMPLIFI_THREAT_METRIX_REQUEST_ID,
      httpTimeoutMs: getNumberEnv("SIMPLIFI_HTTP_TIMEOUT_MS", 30_000),
      syncIntervalMs: getNumberEnv("SIMPLIFI_SYNC_INTERVAL_MS", 60_000),
      maxStaleMs: getNumberEnv("SIMPLIFI_MAX_STALE_MS", 120_000),
      pageLimit: getNumberEnv("SIMPLIFI_PAGE_LIMIT", 5000),
    },
  };
}
