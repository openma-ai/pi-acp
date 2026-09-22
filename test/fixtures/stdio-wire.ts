import { stdioStream } from "../../src/server.ts";

const stream = stdioStream();
const originalWrite = process.stdout.write;
if (process.argv.includes("--takeover")) {
  process.stdout.write = process.stderr.write.bind(process.stderr);
}
const writer = stream.writable.getWriter();
try {
  await writer.write({ jsonrpc: "2.0", id: 1, result: { additionalDirectories: [] } });
  for (let i = 0; i < 8; i++) {
    await writer.write({
      jsonrpc: "2.0",
      method: "session/update",
      params: { index: i, text: "中文🙂".repeat(32768) },
    });
  }
} finally {
  process.stdout.write = originalWrite;
  writer.releaseLock();
  await stream.readable.cancel();
}
