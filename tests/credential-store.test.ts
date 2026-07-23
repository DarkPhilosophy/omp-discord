import { describe, expect, test } from "bun:test";
import { SecretToolCredentialStore, type SecretToolResult } from "../src/credential-store.ts";

type Call = { command: string; args: string[]; options?: { input?: string } };

function runnerFor(result: SecretToolResult | Error, calls: Call[]) {
  return async (command: string, args: string[], options?: { input?: string }) => {
    calls.push({ command, args, options });
    if (result instanceof Error) throw result;
    return result;
  };
}

describe("SecretToolCredentialStore", () => {
  test("trims the looked-up token and treats empty output as disconnected", async () => {
    const calls: Call[] = [];
    const store = new SecretToolCredentialStore({ run: runnerFor({ stdout: "  token-123\n", stderr: "", exitCode: 0 }, calls) });

    await expect(store.get()).resolves.toBe("token-123");
    expect(calls[0]).toEqual({
      command: "secret-tool",
      args: ["lookup", "service", "omp-discord", "account", "local-user"],
      options: undefined,
    });

    const empty = new SecretToolCredentialStore({
      run: runnerFor({ stdout: " \n", stderr: "", exitCode: 0 }, []),
    });
    await expect(empty.get()).resolves.toBeUndefined();
  });

  test("returns disconnected when secret-tool is unavailable or lookup misses", async () => {
    const unavailable = new SecretToolCredentialStore({ run: runnerFor(new Error("secret-tool: command not found"), []) });
    await expect(unavailable.get()).resolves.toBeUndefined();

    const notFound = new SecretToolCredentialStore({
      run: runnerFor({ stdout: "", stderr: "Item not found", exitCode: 1 }, []),
    });
    await expect(notFound.get()).resolves.toBeUndefined();
  });

  test("sanitizes unexpected errors without exposing the token", async () => {
    const token = "top-secret-token";
    const store = new SecretToolCredentialStore({
      run: runnerFor(new Error(`backend failed while handling ${token}`), []),
    });

    await expect(store.set(token)).rejects.toThrow("Unable to store Discord credentials");
    await expect(store.set(token)).rejects.not.toThrow(token);
  });

  test("passes the secret via stdin and never argv", async () => {
    const calls: Call[] = [];
    const store = new SecretToolCredentialStore({
      run: runnerFor({ stdout: "", stderr: "", exitCode: 0 }, calls),
    });

    await store.set("token-123");
    expect(calls[0]).toEqual({
      command: "secret-tool",
      args: ["store", "--label=OMP Discord", "service", "omp-discord", "account", "local-user"],
      options: { input: "token-123" },
    });
    expect(calls[0]?.args.join(" ")).not.toContain("token-123");
  });

  test("clears only the extension account", async () => {
    const calls: Call[] = [];
    const store = new SecretToolCredentialStore({
      run: runnerFor({ stdout: "", stderr: "", exitCode: 0 }, calls),
    });

    await store.delete();
    expect(calls).toEqual([
      {
        command: "secret-tool",
        args: ["clear", "service", "omp-discord", "account", "local-user"],
        options: undefined,
      },
    ]);
  });
});
