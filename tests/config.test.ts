import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DISCORD_CONFIG,
  loadDiscordConfig,
  saveDiscordConfig,
} from "../src/config.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function temporaryConfigPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-discord-config-"));
  roots.push(root);
  return join(root, "discord.yml");
}

describe("Discord configuration", () => {
  test("uses defaults when no saved settings or environment overrides exist", async () => {
    const path = await temporaryConfigPath();

    const result = await loadDiscordConfig({ path, env: {} });

    expect(result.config).toEqual(DEFAULT_DISCORD_CONFIG);
    expect(result.warnings).toEqual([]);
  });

  test("loads nested YAML and gives environment variables precedence", async () => {
    const path = await temporaryConfigPath();
    await writeFile(
      path,
      [
        "follow:",
        "  poll_ms: 3500",
        "  batch_size: 8",
        "  flush_ms: 12000",
        "  history_limit: 75",
        "  resume_on_start: false",
        "  display: id",
        "attachments:",
        "  image_max_bytes: 4000000",
        "  file_max_bytes: 9000000",
        "  text_max_bytes: 500000",
      ].join("\n"),
    );

    const result = await loadDiscordConfig({
      path,
      env: {
        OMP_DISCORD_FOLLOW_BATCH_SIZE: "3",
        OMP_DISCORD_FOLLOW_RESUME_ON_START: "yes",
        OMP_DISCORD_ATTACHMENT_TEXT_MAX_BYTES: "750000",
      },
    });

    expect(result.config).toEqual({
      follow: {
        pollMs: 3500,
        batchSize: 3,
        flushMs: 12000,
        historyLimit: 75,
        resumeOnStart: true,
        display: "id",
      },
      attachments: {
        imageMaxBytes: 4000000,
        fileMaxBytes: 9000000,
        textMaxBytes: 750000,
      },
    });
    expect(result.warnings).toEqual([]);
  });

  test("falls back per invalid value and reports malformed YAML without failing startup", async () => {
    const path = await temporaryConfigPath();
    await writeFile(
      path,
      "follow:\n  poll_ms: nope\n  batch_size: 0\n  resume_on_start: perhaps\n",
    );

    const invalidValues = await loadDiscordConfig({ path, env: {} });
    expect(invalidValues.config.follow.pollMs).toBe(
      DEFAULT_DISCORD_CONFIG.follow.pollMs,
    );
    expect(invalidValues.config.follow.batchSize).toBe(
      DEFAULT_DISCORD_CONFIG.follow.batchSize,
    );
    expect(invalidValues.config.follow.resumeOnStart).toBe(
      DEFAULT_DISCORD_CONFIG.follow.resumeOnStart,
    );
    expect(invalidValues.warnings).toHaveLength(3);

    await writeFile(path, "follow: [");
    const malformed = await loadDiscordConfig({ path, env: {} });
    expect(malformed.config).toEqual(DEFAULT_DISCORD_CONFIG);
    expect(malformed.warnings).toHaveLength(1);
  });

  test("saves settings atomically with private permissions and preserves unknown keys", async () => {
    const path = await temporaryConfigPath();
    await writeFile(
      path,
      "custom:\n  retained: true\nfollow:\n  poll_ms: 900\n",
    );
    await chmod(path, 0o644);

    await saveDiscordConfig(path, {
      follow: { batchSize: 9, resumeOnStart: false },
      attachments: { textMaxBytes: 123456 },
    });

    const saved = Bun.YAML.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(saved).toEqual({
      custom: { retained: true },
      follow: {
        poll_ms: 900,
        batch_size: 9,
        resume_on_start: false,
      },
      attachments: { text_max_bytes: 123456 },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const loaded = await loadDiscordConfig({ path, env: {} });
    expect(loaded.config.follow.pollMs).toBe(900);
    expect(loaded.config.follow.batchSize).toBe(9);
    expect(loaded.config.follow.resumeOnStart).toBe(false);
    expect(loaded.config.attachments.textMaxBytes).toBe(123456);
  });
});
