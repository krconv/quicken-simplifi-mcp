export function logInfo(message: string, payload?: Record<string, unknown>): void {
  if (payload) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ level: "info", message, ...payload }));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: "info", message }));
}

export function logWarn(message: string, payload?: Record<string, unknown>): void {
  if (payload) {
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({ level: "warn", message, ...payload }));
    return;
  }
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ level: "warn", message }));
}

export function logError(message: string, payload?: Record<string, unknown>): void {
  if (payload) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: "error", message, ...payload }));
    return;
  }
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: "error", message }));
}
