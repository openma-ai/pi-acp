/** `--terminal-login`: focused in-process provider login (no pi binary, no TUI). */

import { fauxProvider, type Provider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTerminalLogin, terminalLogin } from "../src/terminal-login.ts";
import { flowProvider, keyableProvider } from "./helpers/auth-providers.ts";

const mocks = vi.hoisted(() => ({
  actualResolveSettings: undefined as undefined | typeof import("../src/settings.ts").resolveSettings,
}));
vi.mock("../src/settings.ts", async (importActual) => {
  const actual = await importActual<typeof import("../src/settings.ts")>();
  mocks.actualResolveSettings = actual.resolveSettings;
  return { ...actual, resolveSettings: vi.fn(actual.resolveSettings) };
});

const { resolveSettings } = await import("../src/settings.ts");
const mockedResolveSettings = vi.mocked(resolveSettings);

function io(lines: string[], tty = false) {
  const input = new PassThrough();
  // Feed one line per tick so readline's pending question is armed before EOF.
  void (async () => {
    for (const line of lines) {
      input.write(line);
      await new Promise((resolve) => setImmediate(resolve));
    }
    input.end();
  })();
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  }) as Writable & { isTTY?: boolean };
  output.isTTY = tty;
  return { input, output, text: () => Buffer.concat(chunks).toString() };
}

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function runtimeWith(...providers: Provider[]) {
  const root = mkdtempSync(join(tmpdir(), "pi-acp-tl-"));
  dirs.push(root);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: join(root, "models.json"),
  });
  for (const provider of providers) modelRuntime.registerNativeProvider(provider);
  // The registry ships ~50 real providers; keep the choice list deterministic.
  vi.spyOn(modelRuntime, "getProviders").mockReturnValue([...providers]);
  return modelRuntime;
}

describe("runTerminalLogin", () => {
  it("logs in through a provider api_key prompt and reports success", async () => {
    const modelRuntime = await runtimeWith(keyableProvider());
    const stream = io(["1\n", "good-key\n"]);
    const code = await runTerminalLogin({ input: stream.input, output: stream.output, modelRuntime });
    expect(code).toBe(0);
    expect(stream.text()).toContain("Signed in to keyable (api_key)");
    expect(modelRuntime.hasConfiguredAuth("keyable")).toBe(true);
  });

  it("masks secret input on a TTY", async () => {
    const modelRuntime = await runtimeWith(keyableProvider());
    const stream = io(["1\n", "good-key\n"], true);
    const code = await runTerminalLogin({ input: stream.input, output: stream.output, modelRuntime });
    expect(code).toBe(0);
    expect(stream.text()).toContain("***");
    expect(stream.text()).not.toContain("good-key");
  });

  it("lists already-configured providers", async () => {
    const modelRuntime = await runtimeWith(keyableProvider());
    await modelRuntime.login("keyable", "api_key", {
      prompt: async () => "good-key",
      notify: () => {},
    });
    const stream = io(["1\n", "good-key\n"]);
    await runTerminalLogin({ input: stream.input, output: stream.output, modelRuntime });
    expect(stream.text()).toContain("Signed in: keyable");
  });

  it("exits 1 when no provider offers interactive login", async () => {
    const modelRuntime = await runtimeWith();
    const stream = io([]);
    const code = await runTerminalLogin({ input: stream.input, output: stream.output, modelRuntime });
    expect(code).toBe(1);
    expect(stream.text()).toContain("No providers support interactive login");
  });

  it("exits 1 on an out-of-range method choice and on EOF", async () => {
    const modelRuntime = await runtimeWith(keyableProvider());
    const bad = io(["9\n"]);
    expect(await runTerminalLogin({ input: bad.input, output: bad.output, modelRuntime })).toBe(1);
    expect(bad.text()).toContain("Enter a number from the list");
    const eof = io([]);
    expect(await runTerminalLogin({ input: eof.input, output: eof.output, modelRuntime })).toBe(1);
    expect(eof.text()).toContain("Login cancelled");
    // Stream already closed before the first question is armed.
    const dead = new PassThrough();
    dead.end();
    await new Promise((resolve) => setImmediate(resolve));
    const deadOut = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    expect(await runTerminalLogin({ input: dead, output: deadOut, modelRuntime })).toBe(1);
  });

  it("rejects a prompt issued after the input already closed", async () => {
    const resilient = {
      ...fauxProvider({ provider: "resilient" }).provider,
      auth: {
        apiKey: {
          name: "Resilient",
          login: async (interaction: {
            prompt: (p: { type: string; message: string }) => Promise<string>;
          }) => {
            try {
              await interaction.prompt({ type: "text", message: "first" });
            } catch {
              // keep going; the stream is already closed
            }
            await interaction.prompt({ type: "text", message: "second" });
            return { type: "api_key", key: "k" };
          },
        },
      },
    } as unknown as Provider;
    const modelRuntime = await runtimeWith(resilient);
    const stream = io(["1\n"]);
    expect(await runTerminalLogin({ input: stream.input, output: stream.output, modelRuntime })).toBe(1);
    expect(stream.text()).toContain("Login failed");
  });

  it("exits 1 when the provider login fails", async () => {
    const modelRuntime = await runtimeWith(keyableProvider());
    const stream = io(["1\n", "wrong\n"]);
    const code = await runTerminalLogin({ input: stream.input, output: stream.output, modelRuntime });
    expect(code).toBe(1);
    expect(stream.text()).toContain("Login failed: bad key");
  });

  it("runs an oauth flow through every prompt and notify type", async () => {
    const modelRuntime = await runtimeWith(flowProvider());
    const stream = io(["1\n", "name\n", "code-123\n", "3\n", "2\n"]);
    const code = await runTerminalLogin({ input: stream.input, output: stream.output, modelRuntime });
    expect(code).toBe(0);
    const text = stream.text();
    expect(text).toContain("https://x/y");
    expect(text).toContain("https://auth.example");
    expect(text).toContain("ABCD-1234");
    expect(text).toContain("Enter a number from the list");
    expect(text).toContain("Signed in to flow (oauth)");
  });

  it("fails cleanly when EOF hits mid-flow", async () => {
    const modelRuntime = await runtimeWith(flowProvider());
    const stream = io(["1\n", "name\n", "code-123\n", "3\n"]);
    const code = await runTerminalLogin({ input: stream.input, output: stream.output, modelRuntime });
    expect(code).toBe(1);
    expect(stream.text()).toContain("Login failed");
  });

  it("shows the provider's own login label when present", async () => {
    const modelRuntime = await runtimeWith(flowProvider("flowl", "Connect Flow SSO"));
    const stream = io(["9\n"]);
    await runTerminalLogin({ input: stream.input, output: stream.output, modelRuntime });
    expect(stream.text()).toContain("Connect Flow SSO");
  });
});

describe("bin dispatch", () => {
  it("routes --terminal-login through the in-process login and exits 1 on EOF", async () => {
    const { execFile } = await import("node:child_process");
    const home = mkdtempSync(join(tmpdir(), "pi-acp-bin-"));
    dirs.push(home);
    const { stdout, code } = await new Promise<{ stdout: string; code: number | null }>((resolve) => {
      execFile(
        process.execPath,
        ["--experimental-transform-types", "src/bin.ts", "--terminal-login"],
        {
          cwd: join(new URL("..", import.meta.url).pathname, ""),
          env: { ...process.env, HOME: home, PI_AGENT_DIR: join(home, ".pi", "agent") },
        },
        (error, stdout) => resolve({ stdout, code: (error as { code?: number })?.code ?? 0 }),
      ).stdin?.end();
    });
    expect(stdout).toContain("Login cancelled");
    expect(code).toBe(1);
  }, 60_000);
});

describe("terminalLogin", () => {
  it("prints help and exits 2 on bad flags", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await terminalLogin(["--bogus-flag"])).toBe(2);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("--terminal-login");
  });

  it("rethrows unexpected settings errors", async () => {
    mockedResolveSettings.mockImplementationOnce(() => {
      throw new TypeError("boom");
    });
    await expect(terminalLogin([])).rejects.toThrow("boom");
  });

  it("reports a readable error when the credential store cannot open", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(ModelRuntime, "create").mockRejectedValue(new Error("no auth store"));
    expect(await terminalLogin([])).toBe(1);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("could not initialize");
  });

  it("runs the login flow against the resolved agent dir", async () => {
    const fakeRuntime = {
      listCredentials: async () => [],
      getProviders: () => [],
    } as unknown as ModelRuntime;
    vi.spyOn(ModelRuntime, "create").mockResolvedValue(fakeRuntime);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await terminalLogin([])).toBe(1);
    expect(stdout.mock.calls.map((c) => String(c[0])).join("")).toContain(
      "No providers support interactive login",
    );
  });
});
