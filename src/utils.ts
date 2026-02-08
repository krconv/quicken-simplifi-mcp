import crypto from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function isExpired(isoTimestamp: string, skewMs = 0): boolean {
  return new Date(isoTimestamp).getTime() <= Date.now() + skewMs;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256Base64Url(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function decodeCursor(cursor?: string): number {
  if (!cursor) {
    return 0;
  }

  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as { offset?: unknown };
    if (typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0) {
      return parsed.offset;
    }
  } catch {
    return 0;
  }

  return 0;
}

export function deepMerge<T>(target: T, patch: unknown): T {
  if (patch === null || patch === undefined) {
    return target;
  }

  if (Array.isArray(patch) || typeof patch !== "object") {
    return patch as T;
  }

  const base = (Array.isArray(target) ? [...target] : { ...(target as Record<string, unknown>) }) as Record<
    string,
    unknown
  >;

  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const existing = base[key];
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      base[key] = deepMerge(existing, value);
    } else {
      base[key] = value;
    }
  }

  return base as T;
}
