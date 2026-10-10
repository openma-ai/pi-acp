import { afterEach, describe, expect, it, vi } from "vitest";

const terminalLogin = vi.hoisted(() => vi.fn(async (_argv: string[]) => 0));
vi.mock("../src/terminal-login.ts", () => ({ terminalLogin }));

const serve = vi.hoisted(() =>
  vi.fn(() => ({ closed: Promise.resolve(), agent: { dispose: async () => {} } })),
);
vi.mock("../src/server.ts", () => ({ serve }));

vi.mock("../src/settings.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/settings.ts")>();
  return { ...original, resolveSettings: vi.fn(original.resolveSettings) };
});

import { main } from "../src/bin.ts";
import { HELP_TEXT, resolveSettings } from "../src/settings.ts";
import { PACKAGE_NAME, VERSION } from "../src/version.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("bin dispatch", () => {
  afterEach(() => {
    process.stdin.removeAllListeners("end");
    process.stdin.removeAllListeners("close");
    process.stdout.removeAllListeners("error");
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    process.exitCode = undefined;
    vi.restoreAllMocks();
    serve.mockReset();
    terminalLogin.mockReset();
    vi.mocked(resolveSettings).mockReset();
  });

  it("--version prints the package version without starting the server", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["--version"]);
    expect(log).toHaveBeenCalledWith(`${PACKAGE_NAME} ${VERSION}`);
    expect(serve).not.toHaveBeenCalled();
    expect(terminalLogin).not.toHaveBeenCalled();
  });

  it("--help prints the help text without starting the server", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["--help"]);
    expect(log).toHaveBeenCalledWith(HELP_TEXT.trimEnd());
    expect(serve).not.toHaveBeenCalled();
  });

  it("--terminal-login sets the exit code from the login flow", async () => {
    terminalLogin.mockResolvedValue(7);
    await main(["--terminal-login"]);
    expect(terminalLogin).toHaveBeenCalledWith(["--terminal-login"]);
    expect(process.exitCode).toBe(7);
    expect(serve).not.toHaveBeenCalled();
  });

  it("a settings error prints help and exits 2 without starting the server", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await main(["--bogus"]);
    expect(process.exitCode).toBe(2);
    expect(stderr).toHaveBeenCalledWith(`\n${HELP_TEXT}`);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("unknown option"));
    expect(serve).not.toHaveBeenCalled();
  });

  it("rethrows non-settings errors", async () => {
    vi.mocked(resolveSettings).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await expect(main([])).rejects.toThrow("boom");
    expect(serve).not.toHaveBeenCalled();
  });

  it("serves and shuts down once on the first close event", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const dispose = vi.fn(async () => {});
    let resolveClosed!: () => void;
    serve.mockReturnValueOnce({
      closed: new Promise<void>((resolve) => {
        resolveClosed = resolve;
      }),
      agent: { dispose },
    });

    const running = main([]);
    process.stdin.emit("end");
    await tick();
    // Every subsequent shutdown trigger is a no-op once shuttingDown is set.
    process.stdin.emit("end");
    process.stdin.emit("close");
    process.stdout.emit("error");
    process.emit("SIGINT");
    process.emit("SIGTERM");
    resolveClosed();
    await running;
    await tick();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(exit).not.toHaveBeenCalledWith(130);
    expect(exit).not.toHaveBeenCalledWith(143);
  });

  it("logs teardown failures and still exits", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    serve.mockReturnValueOnce({
      closed: Promise.resolve(),
      agent: {
        dispose: async () => {
          throw new Error("nope");
        },
      },
    });
    await main([]);
    await tick();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("teardown failed: Error: nope"));
    expect(exit).toHaveBeenCalledWith(0);
  });
});
