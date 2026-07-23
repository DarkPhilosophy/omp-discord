import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOperation,
  cacheListedMessages,
  listCachedMessages,
  listOperations,
  type OperationRecord,
  type SentMessage,
  updateCachedMessage,
} from "../src/session-ledger.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "omp-discord-test-"));
  roots.push(root);
  return root;
}

function sent(messageId: string, content: string): SentMessage {
  return {
    messageId,
    target: { kind: "guild", guildId: "guild-1", channelId: "channel-1" },
    content,
    createdAt: "2026-07-19T10:00:00.000Z",
    updatedAt: "2026-07-19T10:00:00.000Z",
  };
}

describe("session message-selection cache", () => {
  test("isolates every OMP session", async () => {
    const root = await createRoot();
    await cacheListedMessages(root, "session-a", [sent("message-a", "first")]);
    await cacheListedMessages(root, "session-b", [sent("message-b", "second")]);

    expect(await listCachedMessages(root, "session-a")).toEqual([sent("message-a", "first")]);
    expect(await listCachedMessages(root, "session-b")).toEqual([sent("message-b", "second")]);
  });

  test("retains edits and deletion state for a selected message", async () => {
    const root = await createRoot();
    await cacheListedMessages(root, "session-a", [sent("message-a", "before")]);
    await updateCachedMessage(root, "session-a", "message-a", {
      content: "after",
      deleted: true,
      updatedAt: "2026-07-19T10:01:00.000Z",
    });

    expect(await listCachedMessages(root, "session-a")).toEqual([
      {
        ...sent("message-a", "before"),
        content: "after",
        deleted: true,
        updatedAt: "2026-07-19T10:01:00.000Z",
      },
    ]);
  });

  test("persists operation metadata without caching read message bodies", async () => {
    const root = await createRoot();
    const operation: OperationRecord = {
      action: "list_messages",
      target: { kind: "dm", channelId: "channel-1", recipientId: "recipient-1" },
      occurredAt: "2026-07-19T10:02:00.000Z",
      result: { messageIds: ["message-1", "message-2"], count: 2 },
    };

    await appendOperation(root, "session-a", operation);

    expect(await listOperations(root, "session-a")).toEqual([operation]);
    expect(JSON.stringify(await listOperations(root, "session-a"))).not.toContain("message body");
  });

  test("writes session cache owner-only", async () => {
    const root = await createRoot();
    await appendOperation(root, "session-a", {
      action: "list_messages",
      target: { kind: "guild", guildId: "guild-1", channelId: "channel-1" },
      occurredAt: "2026-07-19T10:02:00.000Z",
      result: { count: 0 },
    });

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "operations"))).mode & 0o777).toBe(0o700);
    const [sessionFile] = await readdir(join(root, "operations"));
    if (!sessionFile) throw new Error("expected operation cache file");
    expect((await stat(join(root, "operations", sessionFile))).mode & 0o777).toBe(0o600);
  });
});
