export const SECRET_TOOL_SERVICE = "omp-discord";
export const SECRET_TOOL_ACCOUNT = "local-user";

export interface SecretToolResult {
  stdout: string;
  stderr?: string;
  exitCode?: number;
}

export interface SecretToolRunOptions {
  input?: string;
}

export type SecretToolRunner = (
  command: string,
  args: string[],
  options?: SecretToolRunOptions,
) => Promise<SecretToolResult>;

async function runSecretTool(
  command: string,
  args: string[],
  options?: SecretToolRunOptions,
): Promise<SecretToolResult> {
  const process = Bun.spawn([command, ...args], {
    stdin: options?.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (options?.input !== undefined) {
    const stdin = process.stdin;
    if (!stdin) throw new Error("secret-tool stdin unavailable");
    stdin.write(options.input);
    stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.stderr ? new Response(process.stderr).text() : Promise.resolve(""),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export interface SecretToolCredentialStoreOptions {
  run?: SecretToolRunner;
}

const LOOKUP_ARGS = ["lookup", "service", SECRET_TOOL_SERVICE, "account", SECRET_TOOL_ACCOUNT];
const STORE_ARGS = [
  "store",
  "--label=OMP Discord",
  "service",
  SECRET_TOOL_SERVICE,
  "account",
  SECRET_TOOL_ACCOUNT,
];
const CLEAR_ARGS = ["clear", "service", SECRET_TOOL_SERVICE, "account", SECRET_TOOL_ACCOUNT];

function isUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:enoent|command not found|no such file|not found)/i.test(error.message);
}

function isMissing(result: SecretToolResult): boolean {
  return result.exitCode !== 0 && /(?:not found|no such item|no secret)/i.test(result.stderr ?? "");
}

function failed(result: SecretToolResult): boolean {
  return result.exitCode !== undefined && result.exitCode !== 0;
}

export class SecretToolCredentialStore {
  readonly #run: SecretToolRunner;

  constructor({ run = runSecretTool }: SecretToolCredentialStoreOptions = {}) {
    this.#run = run;
  }

  async get(): Promise<string | undefined> {
    let result: SecretToolResult;
    try {
      result = await this.#run("secret-tool", LOOKUP_ARGS);
    } catch (error) {
      if (isUnavailable(error)) return undefined;
      throw new Error("Unable to read Discord credentials");
    }

    if (isMissing(result)) return undefined;
    if (failed(result)) throw new Error("Unable to read Discord credentials");

    const token = result.stdout.trim();
    return token || undefined;
  }

  async set(token: string): Promise<void> {
    try {
      const result = await this.#run("secret-tool", STORE_ARGS, { input: token });
      if (failed(result)) throw new Error("secret-tool failed");
    } catch {
      throw new Error("Unable to store Discord credentials");
    }
  }

  async save(token: string): Promise<void> {
    return this.set(token);
  }

  async delete(): Promise<void> {
    try {
      const result = await this.#run("secret-tool", CLEAR_ARGS);
      if (failed(result)) throw new Error("secret-tool failed");
    } catch {
      throw new Error("Unable to delete Discord credentials");
    }
  }

  async clear(): Promise<void> {
    return this.delete();
  }
}
