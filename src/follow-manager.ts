import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DiscordAttachmentMetadata } from "./discord-client.ts";
import { targetsMatch, type DiscordTarget } from "./session-ledger.ts";

export interface FollowMessage {
  messageId: string;
  channelId?: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  editedAt?: string;
  author?: { id?: string; username?: string };
  attachments?: DiscordAttachmentMetadata[];
}

interface PersistedFollowState {
  version: 1;
  enabled: boolean;
  target: DiscordTarget;
  cursorId?: string;
  pending: FollowMessage[];
  firstPendingAt?: string;
  updatedAt: string;
}

export interface FollowManagerOptions {
  statePath: string;
  batchSize: number;
  flushMs: number;
  historyLimit: number;
  listMessages(channelId: string, after?: string): Promise<FollowMessage[]>;
  deliver(messages: FollowMessage[], target: DiscordTarget): Promise<void>;
  now?: () => number;
}

export interface FollowStatus {
  active: boolean;
  enabled: boolean;
  ownerSessionId?: string;
  target?: DiscordTarget;
  cursorId?: string;
  pendingCount: number;
  updatedAt?: string;
}

interface RuntimeOwner {
  manager: FollowManager;
  sessionId: string;
}

const runtimeOwners = new Map<string, RuntimeOwner>();

function compareMessageIds(left: string, right: string): number {
  try {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  } catch {
    return left.localeCompare(right);
  }
}

function isTarget(value: unknown): value is DiscordTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  return (
    (target.kind === "guild" ||
      target.kind === "dm" ||
      target.kind === "group-dm") &&
    typeof target.channelId === "string"
  );
}

function isMessage(value: unknown): value is FollowMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.messageId === "string" &&
    typeof message.content === "string" &&
    typeof message.createdAt === "string" &&
    typeof message.updatedAt === "string"
  );
}

function parseState(value: unknown): PersistedFollowState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    typeof state.enabled !== "boolean" ||
    !isTarget(state.target) ||
    !Array.isArray(state.pending) ||
    !state.pending.every(isMessage) ||
    typeof state.updatedAt !== "string" ||
    (state.cursorId !== undefined && typeof state.cursorId !== "string") ||
    (state.firstPendingAt !== undefined &&
      typeof state.firstPendingAt !== "string")
  )
    return undefined;
  return state as unknown as PersistedFollowState;
}

async function readState(
  path: string,
): Promise<PersistedFollowState | undefined> {
  try {
    return parseState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeState(
  path: string,
  state: PersistedFollowState,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    directory,
    `.follow-state.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class FollowManager {
  readonly #options: FollowManagerOptions;
  readonly #ownerKey: string;
  #ownerSessionId?: string;
  #state?: PersistedFollowState;
  #inFlight?: Promise<void>;

  constructor(options: FollowManagerOptions) {
    this.#options = options;
    this.#ownerKey = resolve(options.statePath);
  }

  async start(
    sessionId: string,
    target?: DiscordTarget,
    options: { resume?: boolean } = {},
  ): Promise<FollowStatus> {
    const owner = runtimeOwners.get(this.#ownerKey);
    if (owner && owner.manager !== this) {
      throw new Error(
        `Discord follow is already owned by OMP session ${owner.sessionId}`,
      );
    }
    if (this.#ownerSessionId && this.#ownerSessionId !== sessionId) {
      throw new Error(
        `Discord follow is already owned by OMP session ${this.#ownerSessionId}`,
      );
    }

    runtimeOwners.set(this.#ownerKey, { manager: this, sessionId });
    this.#ownerSessionId = sessionId;
    try {
      const persisted = options.resume
        ? await readState(this.#options.statePath)
        : undefined;
      if (persisted?.enabled) {
        if (target && !targetsMatch(target, persisted.target)) {
          throw new Error(
            "Discord follow target does not match the persisted target",
          );
        }
        this.#state = persisted;
      } else {
        if (!target)
          throw new Error("Discord follow has no persisted target to resume");
        const baseline = await this.#options.listMessages(target.channelId);
        const newest = baseline
          .toSorted((left, right) =>
            compareMessageIds(left.messageId, right.messageId),
          )
          .at(-1);
        this.#state = {
          version: 1,
          enabled: true,
          target,
          cursorId: newest?.messageId,
          pending: [],
          updatedAt: this.#timestamp(),
        };
        await writeState(this.#options.statePath, this.#state);
      }
      return this.status();
    } catch (error) {
      this.#releaseOwner();
      throw error;
    }
  }

  tick(): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    const operation = this.#tick().finally(() => {
      if (this.#inFlight === operation) this.#inFlight = undefined;
    });
    this.#inFlight = operation;
    return operation;
  }

  async flush(): Promise<void> {
    await this.#flush(true);
  }

  async stop(): Promise<FollowStatus> {
    if (this.#inFlight) await this.#inFlight;
    await this.#flush(true);
    if (this.#state) {
      this.#state.enabled = false;
      this.#state.updatedAt = this.#timestamp();
      await writeState(this.#options.statePath, this.#state);
    }
    this.#releaseOwner();
    return this.status();
  }

  async detach(): Promise<void> {
    if (this.#inFlight) await this.#inFlight.catch(() => undefined);
    this.#releaseOwner();
  }

  status(): FollowStatus {
    return {
      active: this.#ownerSessionId !== undefined,
      enabled: this.#state?.enabled ?? false,
      ownerSessionId: this.#ownerSessionId,
      target: this.#state?.target,
      cursorId: this.#state?.cursorId,
      pendingCount: this.#state?.pending.length ?? 0,
      updatedAt: this.#state?.updatedAt,
    };
  }

  async persistedStatus(): Promise<FollowStatus> {
    if (this.#state) return this.status();
    const state = await readState(this.#options.statePath);
    return {
      active: false,
      enabled: state?.enabled ?? false,
      target: state?.target,
      cursorId: state?.cursorId,
      pendingCount: state?.pending.length ?? 0,
      updatedAt: state?.updatedAt,
    };
  }

  async #tick(): Promise<void> {
    const state = this.#requireActiveState();
    const listed = await this.#options.listMessages(
      state.target.channelId,
      state.cursorId,
    );
    const known = new Set(state.pending.map((message) => message.messageId));
    const incoming = listed
      .filter(
        (message) =>
          !state.cursorId ||
          compareMessageIds(message.messageId, state.cursorId) > 0,
      )
      .filter((message) => !known.has(message.messageId))
      .toSorted((left, right) =>
        compareMessageIds(left.messageId, right.messageId),
      );

    if (incoming.length > 0) {
      state.pending.push(...incoming);
      state.cursorId = incoming.at(-1)?.messageId;
      state.firstPendingAt ??= this.#timestamp();
      state.updatedAt = this.#timestamp();
      await writeState(this.#options.statePath, state);
    }
    await this.#flush(false);
  }

  async #flush(force: boolean): Promise<void> {
    const state = this.#requireActiveState();
    if (state.pending.length === 0) return;
    const now = this.#options.now?.() ?? Date.now();
    const age = state.firstPendingAt
      ? now - Date.parse(state.firstPendingAt)
      : 0;
    if (
      !force &&
      state.pending.length < this.#options.batchSize &&
      age < this.#options.flushMs
    )
      return;

    const batch = state.pending.slice();
    await this.#options.deliver(batch, state.target);
    state.pending = [];
    state.firstPendingAt = undefined;
    state.updatedAt = this.#timestamp();
    await writeState(this.#options.statePath, state);
  }

  #requireActiveState(): PersistedFollowState {
    if (!this.#ownerSessionId || !this.#state)
      throw new Error("Discord follow is not active");
    return this.#state;
  }

  #timestamp(): string {
    return new Date(this.#options.now?.() ?? Date.now()).toISOString();
  }

  #releaseOwner(): void {
    const owner = runtimeOwners.get(this.#ownerKey);
    if (owner?.manager === this) runtimeOwners.delete(this.#ownerKey);
    this.#ownerSessionId = undefined;
  }
}
