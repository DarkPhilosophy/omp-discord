import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FollowManager, type FollowMessage } from "../src/follow-manager.ts";
import type { DiscordTarget } from "../src/session-ledger.ts";

const target: DiscordTarget = {
  kind: "guild",
  guildId: "guild-1",
  channelId: "channel-1",
};

const temporaryDirectories: string[] = [];
const managers: FollowManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.detach();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-discord-follow-"));
  temporaryDirectories.push(directory);
  return join(directory, "follow-state.json");
}

function message(messageId: string, content = `message ${messageId}`): FollowMessage {
  return {
    messageId,
    channelId: target.channelId,
    content,
    createdAt: `2026-07-23T00:00:${messageId.padStart(2, "0")}.000Z`,
    updatedAt: `2026-07-23T00:00:${messageId.padStart(2, "0")}.000Z`,
    attachments: [],
  };
}

describe("FollowManager", () => {
  test("persists an underfilled batch and recovers it after the owning session detaches", async () => {
    const path = await statePath();
    let now = Date.parse("2026-07-23T00:00:00.000Z");
    let available = [message("1")];
    const delivered: FollowMessage[][] = [];
    const options = {
      statePath: path,
      batchSize: 5,
      flushMs: 10_000,
      historyLimit: 100,
      now: () => now,
      listMessages: async (_channelId: string, after?: string) => available.filter((item) => !after || BigInt(item.messageId) > BigInt(after)),
      deliver: async (messages: FollowMessage[]) => { delivered.push(messages); },
    };

    const first = new FollowManager(options);
    managers.push(first);
    await first.start("session-a", target);
    available = [message("3"), message("2"), message("1")];
    await first.tick();

    expect(first.status()).toMatchObject({ active: true, cursorId: "3", pendingCount: 2 });
    expect(delivered).toEqual([]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      enabled: true,
      cursorId: "3",
      pending: [{ messageId: "2" }, { messageId: "3" }],
    });

    await first.detach();
    managers.splice(managers.indexOf(first), 1);
    now += 10_000;

    const recovered = new FollowManager(options);
    managers.push(recovered);
    await recovered.start("session-b", target, { resume: true });
    await recovered.tick();

    expect(delivered).toEqual([[message("2"), message("3")]]);
    expect(recovered.status()).toMatchObject({ active: true, cursorId: "3", pendingCount: 0 });
  });

  test("flushes immediately when the configured batch size is reached", async () => {
    const path = await statePath();
    let available = [message("10")];
    const delivered: FollowMessage[][] = [];
    const manager = new FollowManager({
      statePath: path,
      batchSize: 2,
      flushMs: 60_000,
      historyLimit: 100,
      listMessages: async (_channelId, after) => available.filter((item) => !after || BigInt(item.messageId) > BigInt(after)),
      deliver: async (messages) => { delivered.push(messages); },
    });
    managers.push(manager);

    await manager.start("session-a", target);
    available = [message("12"), message("11"), message("10")];
    await manager.tick();

    expect(delivered).toEqual([[message("11"), message("12")]]);
    expect(manager.status().pendingCount).toBe(0);
  });

  test("keeps a failed delivery pending for a later recovery", async () => {
    const path = await statePath();
    let available = [message("20")];
    let fail = true;
    const delivered: FollowMessage[][] = [];
    const options = {
      statePath: path,
      batchSize: 1,
      flushMs: 60_000,
      historyLimit: 100,
      listMessages: async (_channelId: string, after?: string) => available.filter((item) => !after || BigInt(item.messageId) > BigInt(after)),
      deliver: async (messages: FollowMessage[]) => {
        if (fail) throw new Error("delivery unavailable");
        delivered.push(messages);
      },
    };
    const first = new FollowManager(options);
    managers.push(first);
    await first.start("session-a", target);
    available = [message("21"), message("20")];

    await expect(first.tick()).rejects.toThrow("delivery unavailable");
    expect(first.status().pendingCount).toBe(1);
    await first.detach();
    managers.splice(managers.indexOf(first), 1);

    fail = false;
    const recovered = new FollowManager(options);
    managers.push(recovered);
    await recovered.start("session-b", target, { resume: true });
    await recovered.tick();

    expect(delivered).toEqual([[message("21")]]);
    expect(recovered.status().pendingCount).toBe(0);
  });

  test("allows only one live OMP session to own a state file", async () => {
    const path = await statePath();
    const options = {
      statePath: path,
      batchSize: 5,
      flushMs: 10_000,
      historyLimit: 100,
      listMessages: async () => [message("30")],
      deliver: async () => {},
    };
    const first = new FollowManager(options);
    const second = new FollowManager(options);
    managers.push(first, second);

    await first.start("session-a", target);
    await expect(second.start("session-b", target)).rejects.toThrow("session-a");
  });
});
