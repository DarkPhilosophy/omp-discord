import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DiscordConfig {
  follow: {
    pollMs: number;
    batchSize: number;
    flushMs: number;
    historyLimit: number;
    resumeOnStart: boolean;
    /** Widget/status label style for the followed target. */
    display: "name" | "id";
  };
  attachments: {
    imageMaxBytes: number;
    fileMaxBytes: number;
    textMaxBytes: number;
  };
}

export type DiscordConfigPatch = {
  follow?: Partial<DiscordConfig["follow"]>;
  attachments?: Partial<DiscordConfig["attachments"]>;
};

export const DEFAULT_DISCORD_CONFIG_PATH = join(
  homedir(),
  ".omp",
  "agent",
  "discord.yml",
);

export const DEFAULT_DISCORD_CONFIG: DiscordConfig = {
  follow: {
    pollMs: 2_000,
    batchSize: 5,
    flushMs: 10_000,
    historyLimit: 50,
    resumeOnStart: true,
    display: "name",
  },
  attachments: {
    imageMaxBytes: 10 * 1024 * 1024,
    fileMaxBytes: 25 * 1024 * 1024,
    textMaxBytes: 2 * 1024 * 1024,
  },
};

interface LoadDiscordConfigOptions {
  path?: string;
  env?: Record<string, string | undefined>;
}

interface LoadDiscordConfigResult {
  config: DiscordConfig;
  warnings: string[];
}

const CONFIG_TEMPLATE = `# omp-discord configuration
# Environment variables (OMP_DISCORD_*) take priority over this file.
follow:
  # Poll interval for the persistent follow, in milliseconds (250-60000).
  poll_ms: 2000
  # Deliver pending messages once this many have accumulated (1-50).
  batch_size: 5
  # ...or once the oldest pending message is this old, in milliseconds (1000-300000).
  flush_ms: 10000
  # Messages fetched per poll when reading the channel (1-1000).
  history_limit: 50
  # Resume the persisted follow automatically when a session starts.
  resume_on_start: true
  # Followed-target label style in the widget and job list: name (resolved names) or id.
  display: name
attachments:
  # Byte limits for discord_read_attachment downloads.
  image_max_bytes: 10485760
  file_max_bytes: 26214400
  text_max_bytes: 2097152
`;

async function ensureConfigTemplate(path: string): Promise<void> {
  try {
    await readFile(path);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = join(
      dirname(path),
      `.discord.yml.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    await writeFile(temporaryPath, CONFIG_TEMPLATE, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch {
    // Best effort: the loader falls back to defaults without the file.
  }
}

interface SettingSpec {
  yamlSection: "follow" | "attachments";
  yamlKey: string;
  envKey: string;
}

const SPECS = {
  pollMs: {
    yamlSection: "follow",
    yamlKey: "poll_ms",
    envKey: "OMP_DISCORD_FOLLOW_POLL_MS",
  },
  batchSize: {
    yamlSection: "follow",
    yamlKey: "batch_size",
    envKey: "OMP_DISCORD_FOLLOW_BATCH_SIZE",
  },
  flushMs: {
    yamlSection: "follow",
    yamlKey: "flush_ms",
    envKey: "OMP_DISCORD_FOLLOW_FLUSH_MS",
  },
  historyLimit: {
    yamlSection: "follow",
    yamlKey: "history_limit",
    envKey: "OMP_DISCORD_FOLLOW_HISTORY_LIMIT",
  },
  resumeOnStart: {
    yamlSection: "follow",
    yamlKey: "resume_on_start",
    envKey: "OMP_DISCORD_FOLLOW_RESUME_ON_START",
  },
  display: {
    yamlSection: "follow",
    yamlKey: "display",
    envKey: "OMP_DISCORD_FOLLOW_DISPLAY",
  },
  imageMaxBytes: {
    yamlSection: "attachments",
    yamlKey: "image_max_bytes",
    envKey: "OMP_DISCORD_ATTACHMENT_IMAGE_MAX_BYTES",
  },
  fileMaxBytes: {
    yamlSection: "attachments",
    yamlKey: "file_max_bytes",
    envKey: "OMP_DISCORD_ATTACHMENT_FILE_MAX_BYTES",
  },
  textMaxBytes: {
    yamlSection: "attachments",
    yamlKey: "text_max_bytes",
    envKey: "OMP_DISCORD_ATTACHMENT_TEXT_MAX_BYTES",
  },
} satisfies Record<string, SettingSpec>;

export interface DiscordConfigSetting {
  /** Camel-case patch key inside DiscordConfigPatch (e.g. "pollMs"). */
  name: string;
  section: "follow" | "attachments";
  /** YAML key inside the section (e.g. "poll_ms"). */
  key: string;
  env: string;
  kind: "number" | "boolean" | "string";
  /** Allowed values for string settings. */
  values?: readonly string[];
}

/** Settable configuration keys, addressable as `<section>.<key>` (e.g. `follow.poll_ms`). */
export const DISCORD_CONFIG_SETTINGS: DiscordConfigSetting[] = (
  Object.entries(SPECS) as [string, SettingSpec][]
).map(([name, spec]) => ({
  name,
  section: spec.yamlSection,
  key: spec.yamlKey,
  env: spec.envKey,
  kind:
    name === "resumeOnStart"
      ? "boolean"
      : name === "display"
        ? "string"
        : "number",
  ...(name === "display" ? { values: ["name", "id"] as const } : {}),
}));

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function yamlValue(root: Record<string, unknown>, spec: SettingSpec): unknown {
  return record(root[spec.yamlSection])?.[spec.yamlKey];
}

function numberSetting(
  root: Record<string, unknown>,
  env: Record<string, string | undefined>,
  warnings: string[],
  spec: SettingSpec,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidates: Array<{ source: string; value: unknown }> = [
    { source: spec.envKey, value: env[spec.envKey] },
    {
      source: `${spec.yamlSection}.${spec.yamlKey}`,
      value: yamlValue(root, spec),
    },
  ];
  for (const candidate of candidates) {
    if (candidate.value === undefined) continue;
    const parsed =
      typeof candidate.value === "number"
        ? candidate.value
        : typeof candidate.value === "string" && candidate.value.trim() !== ""
          ? Number(candidate.value)
          : Number.NaN;
    if (Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum)
      return parsed;
    warnings.push(
      `${candidate.source} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return fallback;
}

function booleanSetting(
  root: Record<string, unknown>,
  env: Record<string, string | undefined>,
  warnings: string[],
  spec: SettingSpec,
  fallback: boolean,
): boolean {
  const candidates: Array<{ source: string; value: unknown }> = [
    { source: spec.envKey, value: env[spec.envKey] },
    {
      source: `${spec.yamlSection}.${spec.yamlKey}`,
      value: yamlValue(root, spec),
    },
  ];
  for (const candidate of candidates) {
    if (candidate.value === undefined) continue;
    if (typeof candidate.value === "boolean") return candidate.value;
    if (typeof candidate.value === "string") {
      const normalized = candidate.value.trim().toLocaleLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) return true;
      if (["0", "false", "no", "off"].includes(normalized)) return false;
    }
    warnings.push(`${candidate.source} must be a boolean`);
  }
  return fallback;
}

function enumSetting<T extends string>(
  root: Record<string, unknown>,
  env: Record<string, string | undefined>,
  warnings: string[],
  spec: SettingSpec,
  fallback: T,
  allowed: readonly T[],
): T {
  const candidates: Array<{ source: string; value: unknown }> = [
    { source: spec.envKey, value: env[spec.envKey] },
    {
      source: `${spec.yamlSection}.${spec.yamlKey}`,
      value: yamlValue(root, spec),
    },
  ];
  for (const candidate of candidates) {
    if (candidate.value === undefined) continue;
    if (typeof candidate.value === "string") {
      const normalized = candidate.value.trim().toLocaleLowerCase() as T;
      if (allowed.includes(normalized)) return normalized;
    }
    warnings.push(`${candidate.source} must be one of: ${allowed.join(", ")}`);
  }
  return fallback;
}

async function readYaml(
  path: string,
): Promise<{ root: Record<string, unknown>; warning?: string }> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { root: {} };
    throw error;
  }
  try {
    const parsed = Bun.YAML.parse(source);
    const root = record(parsed);
    return root
      ? { root }
      : { root: {}, warning: `${path} must contain a YAML mapping` };
  } catch {
    return { root: {}, warning: `${path} contains invalid YAML` };
  }
}

export async function loadDiscordConfig(
  options: LoadDiscordConfigOptions = {},
): Promise<LoadDiscordConfigResult> {
  const path = options.path ?? DEFAULT_DISCORD_CONFIG_PATH;
  const env = options.env ?? process.env;
  await ensureConfigTemplate(path);
  const loaded = await readYaml(path);
  const warnings = loaded.warning ? [loaded.warning] : [];
  const root = loaded.root;

  return {
    config: {
      follow: {
        pollMs: numberSetting(
          root,
          env,
          warnings,
          SPECS.pollMs,
          DEFAULT_DISCORD_CONFIG.follow.pollMs,
          250,
          60_000,
        ),
        batchSize: numberSetting(
          root,
          env,
          warnings,
          SPECS.batchSize,
          DEFAULT_DISCORD_CONFIG.follow.batchSize,
          1,
          50,
        ),
        flushMs: numberSetting(
          root,
          env,
          warnings,
          SPECS.flushMs,
          DEFAULT_DISCORD_CONFIG.follow.flushMs,
          1_000,
          300_000,
        ),
        historyLimit: numberSetting(
          root,
          env,
          warnings,
          SPECS.historyLimit,
          DEFAULT_DISCORD_CONFIG.follow.historyLimit,
          1,
          1_000,
        ),
        resumeOnStart: booleanSetting(
          root,
          env,
          warnings,
          SPECS.resumeOnStart,
          DEFAULT_DISCORD_CONFIG.follow.resumeOnStart,
        ),
        display: enumSetting(
          root,
          env,
          warnings,
          SPECS.display,
          DEFAULT_DISCORD_CONFIG.follow.display,
          ["name", "id"] as const,
        ),
      },
      attachments: {
        imageMaxBytes: numberSetting(
          root,
          env,
          warnings,
          SPECS.imageMaxBytes,
          DEFAULT_DISCORD_CONFIG.attachments.imageMaxBytes,
          1,
          100 * 1024 * 1024,
        ),
        fileMaxBytes: numberSetting(
          root,
          env,
          warnings,
          SPECS.fileMaxBytes,
          DEFAULT_DISCORD_CONFIG.attachments.fileMaxBytes,
          1,
          250 * 1024 * 1024,
        ),
        textMaxBytes: numberSetting(
          root,
          env,
          warnings,
          SPECS.textMaxBytes,
          DEFAULT_DISCORD_CONFIG.attachments.textMaxBytes,
          1,
          25 * 1024 * 1024,
        ),
      },
    },
    warnings,
  };
}

function applyPatch(
  root: Record<string, unknown>,
  patch: DiscordConfigPatch,
): void {
  if (patch.follow) {
    const follow = { ...record(root.follow) };
    if (patch.follow.pollMs !== undefined) follow.poll_ms = patch.follow.pollMs;
    if (patch.follow.batchSize !== undefined)
      follow.batch_size = patch.follow.batchSize;
    if (patch.follow.flushMs !== undefined)
      follow.flush_ms = patch.follow.flushMs;
    if (patch.follow.historyLimit !== undefined)
      follow.history_limit = patch.follow.historyLimit;
    if (patch.follow.resumeOnStart !== undefined)
      follow.resume_on_start = patch.follow.resumeOnStart;
    root.follow = follow;
  }
  if (patch.attachments) {
    const attachments = { ...record(root.attachments) };
    if (patch.attachments.imageMaxBytes !== undefined)
      attachments.image_max_bytes = patch.attachments.imageMaxBytes;
    if (patch.attachments.fileMaxBytes !== undefined)
      attachments.file_max_bytes = patch.attachments.fileMaxBytes;
    if (patch.attachments.textMaxBytes !== undefined)
      attachments.text_max_bytes = patch.attachments.textMaxBytes;
    root.attachments = attachments;
  }
}

export async function saveDiscordConfig(
  path: string,
  patch: DiscordConfigPatch,
): Promise<void> {
  const existing = await readYaml(path);
  if (existing.warning) throw new Error(existing.warning);
  const root = existing.root;
  applyPatch(root, patch);

  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    directory,
    `.discord.yml.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporaryPath, Bun.YAML.stringify(root), {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await Bun.file(temporaryPath)
      .delete()
      .catch(() => undefined);
    throw error;
  }
}
