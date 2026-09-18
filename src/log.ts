/**
 * Diagnostics go to stderr only: stdout is the ACP wire.
 */

const PREFIX = "[openma-pi-acp]";

export function isDebugEnabled(): boolean {
  const value = process.env["PI_ACP_DEBUG"];
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function write(level: string, message: string): void {
  try {
    process.stderr.write(`${PREFIX} ${level}: ${message}\n`);
  } catch {
    // stderr may be closed by the host; diagnostics are best-effort.
  }
}

export function logDebug(message: string): void {
  if (isDebugEnabled()) write("debug", message);
}

export function logInfo(message: string): void {
  write("info", message);
}

export function logWarn(message: string): void {
  write("warn", message);
}

export function logError(message: string): void {
  write("error", message);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const chain: string[] = [error.message];
    let cause: unknown = error.cause;
    let depth = 0;
    while (cause !== undefined && cause !== null && depth < 5) {
      chain.push(cause instanceof Error ? cause.message : String(cause));
      cause = cause instanceof Error ? cause.cause : undefined;
      depth += 1;
    }
    return chain.join(": ");
  }
  return String(error);
}
