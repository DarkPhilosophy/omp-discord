import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zodToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import type { DiscordClient } from "../src/discord-client.ts";
import { createDiscordExtension } from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
type ToolParameters = { parse: (params: unknown) => unknown };

type RegisteredTool = {
  execute: (...args: never[]) => Promise<unknown>;
  loadMode?: string;
  name?: string;
  parameters?: ToolParameters;
};

type RegisteredCommand = {
  description: string;
  getArgumentCompletions?: (
    prefix: string,
  ) => Array<{ label: string; description: string; value: string }> | null;
  handler: (args: string, context: ExtensionContext) => Promise<void>;
};

function extensionApi(
  tools: Map<string, RegisteredTool>,
  commands = new Map<string, RegisteredCommand>(),
): ExtensionAPI {
  return {
    zod: z,
    setLabel: () => undefined,
    registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
    registerTool: (tool: RegisteredTool) => {
      if (!tool.name) throw new Error("tool missing name");
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
}

function context(sessionId: string): ExtensionContext {
  return {
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

async function execute(
  tools: Map<string, RegisteredTool>,
  name: string,
  params: unknown,
  sessionId: string,
): Promise<unknown> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`missing tool ${name}`);
  if (!tool.parameters) throw new Error(`tool ${name} missing parameters`);
  return (tool.execute as (...args: unknown[]) => Promise<unknown>)(
    "call",
    tool.parameters.parse(params),
    new AbortController().signal,
    undefined,
    context(sessionId),
  );
}

describe("Discord extension", () => {
  test("registers the complete scoped toolset and interactive Discord command", () => {
    const tools = new Map<string, RegisteredTool>();
    const commands = new Map<string, RegisteredCommand>();
    createDiscordExtension(extensionApi(tools, commands), {
      client: {} as DiscordClient,
    });

    expect([...tools.keys()].sort()).toEqual([
      "discord_delete_message",
      "discord_edit_message",
      "discord_follow_start",
      "discord_follow_status",
      "discord_follow_stop",
      "discord_list_dms",
      "discord_list_group_dms",
      "discord_list_guild_channels",
      "discord_list_guilds",
      "discord_list_messages",
      "discord_list_operations",
      "discord_login",
      "discord_logout",
      "discord_read_attachment",
      "discord_search_messages",
      "discord_send_message",
      "discord_status",
    ]);
    expect([...tools.values()].every((tool) => tool.loadMode === "essential")).toBe(true);
    expect(commands.get("discord")?.getArgumentCompletions?.("lo")).toEqual([
      {
        label: "login",
        description: "Save a local Discord credential",
        value: "login",
      },
      {
        label: "logout",
        description: "Remove the local Discord credential",
        value: "logout",
      },
    ]);
    expect(commands.get("discord")?.getArgumentCompletions?.("f")).toEqual([
      {
        label: "follow",
        description: "Manage the persistent Discord message follow",
        value: "follow",
      },
    ]);
  });

  test("publishes a permissive, explicit target shape to the host wire schema", () => {
    const tools = new Map<string, RegisteredTool>();
    createDiscordExtension(extensionApi(tools), {
      client: {} as DiscordClient,
    });

    const tool = tools.get("discord_list_messages");
    if (!tool?.parameters) throw new Error("discord_list_messages is missing parameters");
    const schema = zodToWireSchema(tool.parameters as never) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(schema.required).toBeUndefined();
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["limit", "scope", "target"]);
  });

  test("enforces Discord message and embed limits in the published tool schemas", () => {
    const tools = new Map<string, RegisteredTool>();
    createDiscordExtension(extensionApi(tools), {
      client: {} as DiscordClient,
    });

    const send = tools.get("discord_send_message")?.parameters as
      | { safeParse: (input: unknown) => { success: boolean } }
      | undefined;
    const edit = tools.get("discord_edit_message")?.parameters as
      | { safeParse: (input: unknown) => { success: boolean } }
      | undefined;
    if (!send || !edit) throw new Error("Discord message tools are missing parameters");

    const target = { kind: "dm", channelId: "channel-1", recipientId: "user-1" };
    expect(send.safeParse({ target, content: "x".repeat(2_001) }).success).toBe(true);
    expect(send.safeParse({ target, content: "x".repeat(4_001) }).success).toBe(false);
    expect(
      send.safeParse({
        target,
        embeds: [{ description: "x".repeat(4_000) }, { description: "x".repeat(2_001) }],
      }).success,
    ).toBe(false);
    expect(
      send.safeParse({
        target,
        embeds: [{ title: "x".repeat(257) }],
      }).success,
    ).toBe(false);
    expect(edit.safeParse({ messageId: "message-1", content: "x".repeat(4_001) }).success).toBe(
      false,
    );
  });
  test("lists safe attachment metadata and returns image content without exposing CDN URLs", async () => {
    const tools = new Map<string, RegisteredTool>();
    const client = {
      listGuildChannels: async () => [{ id: "channel-1", type: 0 }],
      listMessages: async () => [
        {
          id: "message-1",
          channel_id: "channel-1",
          content: "image attached",
          timestamp: "2026-07-19T12:00:00.000Z",
          attachments: [
            {
              id: "attachment-1",
              filename: "diagram.png",
              content_type: "image/png",
              size: 4,
              width: 2,
              height: 2,
              url: "https://cdn.discordapp.com/attachments/private",
            },
          ],
        },
      ],
      readAttachment: async () => ({
        attachment: {
          id: "attachment-1",
          filename: "diagram.png",
          contentType: "image/png",
          size: 4,
          width: 2,
          height: 2,
        },
        data: new Uint8Array([1, 2, 3, 4]),
      }),
    } as unknown as DiscordClient;
    createDiscordExtension(extensionApi(tools), { client });

    const listed = (await execute(
      tools,
      "discord_list_messages",
      {
        scope: "all",
        target: { kind: "guild", guildId: "guild-1", channelId: "channel-1" },
        limit: 10,
      },
      "session-a",
    )) as { content: Array<{ text?: string }> };
    const messages = JSON.parse(listed.content[0]?.text ?? "[]");
    expect(messages[0].attachments).toEqual([
      {
        id: "attachment-1",
        filename: "diagram.png",
        contentType: "image/png",
        size: 4,
        width: 2,
        height: 2,
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain("cdn.discordapp.com");

    const read = (await execute(
      tools,
      "discord_read_attachment",
      {
        channelId: "channel-1",
        messageId: "message-1",
        attachmentId: "attachment-1",
      },
      "session-a",
    )) as {
      content: Array<{
        data?: string;
        mimeType?: string;
        text?: string;
        type: string;
      }>;
    };
    expect(JSON.parse(read.content[0]?.text ?? "{}")).toEqual({
      id: "attachment-1",
      filename: "diagram.png",
      contentType: "image/png",
      size: 4,
      width: 2,
      height: 2,
    });
    expect(read.content[1]).toEqual({
      type: "image",
      data: Buffer.from([1, 2, 3, 4]).toString("base64"),
      mimeType: "image/png",
    });
  });

  test("validates a direct credential before storing it without exposing its value", async () => {
    const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
    const commands = new Map<string, RegisteredCommand>();
    const validated: string[] = [];
    const stored: string[] = [];
    const client = {
      validateCredential: async (value: string) => {
        validated.push(value);
        return { global_name: "Alex", mfa_enabled: true, username: "alex" };
      },
    } as unknown as DiscordClient;
    createDiscordExtension(extensionApi(tools, commands), {
      client,
      credential: {
        delete: async () => undefined,
        get: async () => undefined,
        set: async (value) => {
          stored.push(value);
        },
      },
    });

    const notifications: Array<{ level: string; message: string }> = [];
    const command = commands.get("discord");
    if (!command) throw new Error("missing discord command");
    await command.handler('login "credential-value"', {
      ui: {
        notify: async (message: string, level: string) => {
          notifications.push({ level, message });
        },
      },
    } as unknown as ExtensionContext);

    expect(validated).toEqual(["credential-value"]);
    expect(stored).toEqual(["credential-value"]);
    expect(notifications).toEqual([
      {
        level: "info",
        message:
          "󰙯 Discord account verified\nUsername: @alex\nDisplay name: Alex\nAccount type: User\nSecurity: MFA enabled\nCredential stored in the local OS secret service.",
      },
    ]);
  });

  test("authenticates and stores a credential through the native login tool without returning it", async () => {
    const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
    const validated: string[] = [];
    const stored: string[] = [];
    const deleted: boolean[] = [];
    const client = {
      validateCredential: async (value: string) => {
        validated.push(value);
        return { bot: false, username: "alex" };
      },
    } as unknown as DiscordClient;
    createDiscordExtension(extensionApi(tools), {
      client,
      credential: {
        delete: async () => {
          deleted.push(true);
        },
        get: async () => undefined,
        set: async (value) => {
          stored.push(value);
        },
      },
    });

    const tool = tools.get("discord_login");
    if (!tool) throw new Error("missing discord_login tool");
    const executeLogin = tool.execute as unknown as (...args: unknown[]) => Promise<unknown>;
    const result = (await executeLogin("call", {}, new AbortController().signal, undefined, {
      sessionManager: { getSessionId: () => "session-a" },
      ui: { input: async () => "credential-value" },
    } as unknown as ExtensionContext)) as { content: Array<{ text: string }> };

    expect(validated).toEqual(["credential-value"]);
    expect(stored).toEqual(["credential-value"]);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      accountType: "user",
      username: "alex",
    });
    expect(result.content[0]?.text).not.toContain("credential-value");

    const logout = tools.get("discord_logout");
    if (!logout) throw new Error("missing discord_logout tool");
    const executeLogout = logout.execute as unknown as (...args: unknown[]) => Promise<unknown>;
    const logoutResult = (await executeLogout(
      "call",
      {},
      new AbortController().signal,
      undefined,
      {} as ExtensionContext,
    )) as { content: Array<{ text: string }> };
    expect(deleted).toEqual([true]);
    expect(JSON.parse(logoutResult.content[0]?.text ?? "")).toEqual({
      disconnected: true,
    });
  });

  test("validates the Discord credential and reports the active account", async () => {
    const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
    const commands = new Map<string, RegisteredCommand>();
    let currentUserLookups = 0;
    const client = {
      getCurrentUser: async () => {
        currentUserLookups++;
        return { global_name: "Alex", mfa_enabled: true, username: "alex" };
      },
    } as unknown as DiscordClient;
    createDiscordExtension(extensionApi(tools, commands), {
      client,
      credential: {
        delete: async () => undefined,
        get: async () => "credential",
        set: async () => undefined,
      },
    });

    const notifications: Array<{ level: string; message: string }> = [];
    const command = commands.get("discord");
    if (!command) throw new Error("missing discord command");
    await command.handler("status", {
      ui: {
        notify: (message: string, level: string) => notifications.push({ level, message }),
      },
    } as unknown as ExtensionContext);

    expect(currentUserLookups).toBe(1);
    expect(notifications).toEqual([
      {
        level: "info",
        message:
          "󰙯 Discord account verified\nUsername: @alex\nDisplay name: Alex\nAccount type: User\nSecurity: MFA enabled",
      },
    ]);
  });

  test("permits mutations only for message identifiers returned by this session's message list", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "omp-discord-index-"));
    roots.push(cacheRoot);
    const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
    const calls: Array<{
      action: string;
      channelId: string;
      content?: string;
      messageId: string;
    }> = [];
    const client = {
      deleteMessage: async (channelId: string, messageId: string) => {
        calls.push({ action: "delete", channelId, messageId });
      },
      editMessage: async (channelId: string, messageId: string, message: { content?: string }) => {
        calls.push({ action: "edit", channelId, content: message.content, messageId });
        return { content: message.content, id: messageId };
      },
      listDirectChannels: async () => [{ id: "dm-1", recipients: [{ id: "user-1" }], type: 1 }],
      sendMessage: async () => ({
        content: "sent in session A",
        id: "message-1",
        timestamp: "2026-07-19T12:00:00.000Z",
      }),
      listMessages: async () => [
        {
          content: "listed in session A",
          id: "message-1",
          timestamp: "2026-07-19T12:00:00.000Z",
        },
      ],
    } as unknown as DiscordClient;
    createDiscordExtension(extensionApi(tools), { cacheRoot, client });

    await expect(
      execute(
        tools,
        "discord_edit_message",
        {
          messageId: "random-id",
          content: "must not edit",
        },
        "session-a",
      ),
    ).rejects.toThrow("cached message list");

    await execute(
      tools,
      "discord_send_message",
      {
        content: "sent in session A",
        target: { kind: "dm", channelId: "dm-1", recipientId: "user-1" },
      },
      "session-a",
    );
    await execute(
      tools,
      "discord_edit_message",
      { messageId: "message-1", content: "edited in session A" },
      "session-a",
    );
    await execute(tools, "discord_delete_message", { messageId: "message-1" }, "session-a");

    const cached = (await execute(
      tools,
      "discord_list_messages",
      { scope: "session" },
      "session-a",
    )) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(cached.content[0]?.text ?? "")).toEqual([
      expect.objectContaining({
        content: "edited in session A",
        deleted: true,
        messageId: "message-1",
      }),
    ]);
    await expect(
      execute(tools, "discord_delete_message", { messageId: "message-1" }, "session-a"),
    ).rejects.toThrow("cached message list");
    await expect(
      execute(tools, "discord_delete_message", { messageId: "message-1" }, "session-b"),
    ).rejects.toThrow("cached message list");

    expect(calls).toEqual([
      {
        action: "edit",
        channelId: "dm-1",
        content: "edited in session A",
        messageId: "message-1",
      },
      { action: "delete", channelId: "dm-1", messageId: "message-1" },
    ]);
  });

  test("rejects a target that does not belong to its declared category", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "omp-discord-index-"));
    roots.push(cacheRoot);
    const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
    let sent = false;
    const client = {
      listGuildChannels: async () => [{ id: "other-channel", type: 0 }],
      sendMessage: async () => {
        sent = true;
        return { id: "message-1" };
      },
    } as unknown as DiscordClient;
    createDiscordExtension(extensionApi(tools), { cacheRoot, client });

    await expect(
      execute(
        tools,
        "discord_send_message",
        {
          content: "must not send",
          target: { kind: "guild", guildId: "guild-1", channelId: "channel-1" },
        },
        "session-a",
      ),
    ).rejects.toThrow("does not belong to the selected guild");

    expect(sent).toBe(false);
  });

  test("passes rich message fields and selected uploads through to the Discord client", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "omp-discord-index-"));
    roots.push(cacheRoot);
    const attachmentPath = join(cacheRoot, "diagram.txt");
    await writeFile(attachmentPath, "diagram");
    const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
    const sent: unknown[] = [];
    const client = {
      listDirectChannels: async () => [{ id: "dm-1", recipients: [{ id: "user-1" }] }],
      sendMessage: async (_channelId: string, payload: unknown) => {
        sent.push(payload);
        return {
          id: "message-1",
          channel_id: "dm-1",
          content: "",
          timestamp: "2026-07-19T12:00:00.000Z",
        };
      },
    } as unknown as DiscordClient;
    createDiscordExtension(extensionApi(tools), { cacheRoot, client });

    await execute(
      tools,
      "discord_send_message",
      {
        target: { kind: "dm", channelId: "dm-1", recipientId: "user-1" },
        embeds: [{ title: "Status", description: "Everything is operational." }],
        attachments: [{ path: attachmentPath, description: "Status details" }],
      },
      "session-a",
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      embeds: [{ title: "Status", description: "Everything is operational." }],
      attachments: [
        {
          filename: "diagram.txt",
          description: "Status details",
        },
      ],
    });
    expect((sent[0] as { attachments: Array<{ file: Blob }> }).attachments[0]?.file).toBeInstanceOf(
      Blob,
    );
  });

  test("rejects missing and oversized uploads before sending a Discord request", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "omp-discord-index-"));
    roots.push(cacheRoot);
    const oversizedPath = join(cacheRoot, "oversized.bin");
    await writeFile(oversizedPath, "");
    await truncate(oversizedPath, 10 * 1024 * 1024 + 1);
    const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
    const sent: unknown[] = [];
    const client = {
      sendMessage: async (...args: unknown[]) => {
        sent.push(args);
        return {};
      },
    } as unknown as DiscordClient;
    createDiscordExtension(extensionApi(tools), { cacheRoot, client });
    const target = { kind: "dm", channelId: "dm-1", recipientId: "user-1" };

    await expect(
      execute(
        tools,
        "discord_send_message",
        { target, attachments: [{ path: join(cacheRoot, "missing.txt") }] },
        "session-a",
      ),
    ).rejects.toThrow("Unable to read Discord attachment");
    await expect(
      execute(
        tools,
        "discord_send_message",
        { target, attachments: [{ path: oversizedPath }] },
        "session-a",
      ),
    ).rejects.toThrow("maximum is 10485760 bytes");
    expect(sent).toHaveLength(0);
  });

  test("separates live channel reads from this session's sent-message archive", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "omp-discord-index-"));
    roots.push(cacheRoot);
    const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
    let liveReads = 0;
    const client = {
      listGuildChannels: async () => [{ id: "channel-1", type: 0 }],
      listMessages: async () => {
        liveReads += 1;
        return [
          {
            author: { id: "another-user", username: "Other" },
            content: "live message",
            id: "live-1",
            timestamp: "2026-07-19T12:00:00.000Z",
          },
        ];
      },
      sendMessage: async () => ({
        content: "sent by this session",
        id: "sent-1",
        timestamp: "2026-07-19T12:01:00.000Z",
      }),
    } as unknown as DiscordClient;
    createDiscordExtension(extensionApi(tools), { cacheRoot, client });

    await expect(
      execute(tools, "discord_list_messages", { scope: "all" }, "session-a"),
    ).rejects.toThrow("target is required when scope is all");

    await execute(
      tools,
      "discord_send_message",
      {
        content: "sent by this session",
        target: { kind: "guild", guildId: "guild-1", channelId: "channel-1" },
      },
      "session-a",
    );

    const sessionResult = (await execute(
      tools,
      "discord_list_messages",
      { scope: "session" },
      "session-a",
    )) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(sessionResult.content[0]?.text ?? "")).toEqual([
      expect.objectContaining({
        content: "sent by this session",
        messageId: "sent-1",
      }),
    ]);
    expect(liveReads).toBe(0);

    const allResult = (await execute(
      tools,
      "discord_list_messages",
      {
        scope: "all",
        target: { kind: "guild", guildId: "guild-1", channelId: "channel-1" },
      },
      "session-a",
    )) as { content: Array<{ text: string }> };
    expect(JSON.parse(allResult.content[0]?.text ?? "")).toEqual([
      expect.objectContaining({ content: "live message", messageId: "live-1" }),
    ]);
    expect(liveReads).toBe(1);
    await expect(
      execute(tools, "discord_delete_message", { messageId: "live-1" }, "session-a"),
    ).rejects.toThrow("cached message list");
  });

  test("lists selectable message identifiers with their timestamps and content", async () => {
    const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
    const client = {
      listDirectChannels: async () => [{ id: "dm-1", recipients: [{ id: "user-1" }], type: 1 }],
      listMessages: async () => [
        {
          author: { id: "user-1", username: "Alex" },
          content: "the tenth message",
          id: "message-10",
          timestamp: "2026-07-19T12:34:56.000Z",
        },
      ],
    } as unknown as DiscordClient;
    createDiscordExtension(extensionApi(tools), { client });

    const result = (await execute(
      tools,
      "discord_list_messages",
      {
        limit: 5,
        target: { kind: "dm", channelId: "dm-1", recipientId: "user-1" },
      },
      "session-a",
    )) as { content: Array<{ text: string }> };

    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual([
      {
        author: { id: "user-1", username: "Alex" },
        attachments: [],
        content: "the tenth message",
        createdAt: "2026-07-19T12:34:56.000Z",
        deleted: false,
        messageId: "message-10",
        updatedAt: "2026-07-19T12:34:56.000Z",
      },
    ]);
  });

  test("lists live channel messages without making them mutable", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "omp-discord-index-"));
    roots.push(cacheRoot);
    const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
    const client = {
      listDirectChannels: async () => [{ id: "dm-1", recipients: [{ id: "user-1" }], type: 1 }],
      listMessages: async () => [
        {
          content: "first message",
          id: "first",
          timestamp: "2026-07-19T12:00:00.000Z",
        },
        {
          content: "second message",
          id: "second",
          timestamp: "2026-07-19T12:01:00.000Z",
        },
      ],
    } as unknown as DiscordClient;
    createDiscordExtension(extensionApi(tools), { cacheRoot, client });

    const result = (await execute(
      tools,
      "discord_list_messages",
      {
        limit: 100,
        scope: "all",
        target: { kind: "dm", channelId: "dm-1", recipientId: "user-1" },
      },
      "session-a",
    )) as { content: Array<{ text: string }>; details: { count: number } };

    expect(result.details.count).toBe(2);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual([
      expect.objectContaining({ content: "first message", messageId: "first" }),
      expect.objectContaining({
        content: "second message",
        messageId: "second",
      }),
    ]);

    await expect(
      execute(tools, "discord_delete_message", { messageId: "first" }, "session-a"),
    ).rejects.toThrow("cached message list");
  });

  test("searches only the most recent visible channel messages", async () => {
    const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
    const client = {
      listDirectChannels: async () => [{ id: "dm-1", recipients: [{ id: "user-1" }], type: 1 }],
      listMessages: async () => [
        {
          content: "first message",
          id: "first",
          timestamp: "2026-07-19T12:00:00.000Z",
        },
        {
          content: "second message",
          id: "second",
          timestamp: "2026-07-19T12:01:00.000Z",
        },
      ],
    } as unknown as DiscordClient;
    createDiscordExtension(extensionApi(tools), { client });

    const result = (await execute(
      tools,
      "discord_search_messages",
      {
        limit: 10,
        query: "first",
        target: { kind: "dm", channelId: "dm-1", recipientId: "user-1" },
      },
      "session-a",
    )) as { content: Array<{ text: string }>; details: { count: number } };

    expect(result.details.count).toBe(1);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual([
      expect.objectContaining({ content: "first message", messageId: "first" }),
    ]);
  });
});

test("exposes the authenticated account through the native status tool", async () => {
  const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
  let currentUserLookups = 0;
  const client = {
    getCurrentUser: async () => {
      currentUserLookups++;
      return {
        bot: false,
        global_name: "Alex",
        id: "user-1",
        mfa_enabled: true,
        username: "alex",
      };
    },
  } as unknown as DiscordClient;
  createDiscordExtension(extensionApi(tools), { client });

  const result = (await execute(tools, "discord_status", {}, "session-a")) as {
    content: Array<{ text: string }>;
    details: unknown;
  };

  expect(currentUserLookups).toBe(1);
  expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
    accountType: "user",
    displayName: "Alex",
    mfaEnabled: true,
    userId: "user-1",
    username: "alex",
  });
  expect(result.details).toEqual({
    accountType: "user",
    displayName: "Alex",
    mfaEnabled: true,
    userId: "user-1",
    username: "alex",
  });
});

describe("Discord follow extension integration", () => {
  test("starts, reports, and stops one session-owned follow", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "omp-discord-follow-index-"));
    roots.push(cacheRoot);
    const tools = new Map<string, RegisteredTool>();
    const client = {
      listDirectChannels: async () => [{ id: "dm-1", recipients: [{ id: "user-1" }], type: 1 }],
      listMessages: async () => [
        {
          content: "baseline",
          id: "message-1",
          timestamp: "2026-07-19T12:00:00.000Z",
        },
      ],
    } as unknown as DiscordClient;
    createDiscordExtension(extensionApi(tools), { cacheRoot, client });

    const started = (await execute(
      tools,
      "discord_follow_start",
      {
        target: { kind: "dm", channelId: "dm-1", recipientId: "user-1" },
      },
      "session-a",
    )) as { details: { enabled: boolean; ownerSessionId: string } };
    expect(started.details).toEqual(
      expect.objectContaining({
        enabled: true,
        ownerSessionId: "session-a",
      }),
    );

    const status = (await execute(tools, "discord_follow_status", {}, "session-a")) as {
      details: { enabled: boolean; target: { channelId: string } };
    };
    expect(status.details).toEqual(
      expect.objectContaining({
        enabled: true,
        target: expect.objectContaining({ channelId: "dm-1" }),
      }),
    );

    const stopped = (await execute(tools, "discord_follow_stop", {}, "session-a")) as {
      details: { enabled: boolean; ownerSessionId?: string };
    };
    expect(stopped.details.enabled).toBe(false);
    expect(stopped.details.ownerSessionId).toBeUndefined();
  });
});

describe("Discord follow background job", () => {
  interface FakeJobCall {
    type: string;
    label: string;
    options?: { id?: string; ownerId?: string };
    result: Promise<string>;
    abort: AbortController;
    progress: Array<{ text: string; details?: Record<string, unknown> }>;
  }

  function fakeJobRegistry(calls: FakeJobCall[]) {
    return {
      register(
        type: "bash" | "task",
        label: string,
        run: (ctx: {
          jobId: string;
          signal: AbortSignal;
          reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
          markRunning: () => void;
        }) => Promise<string>,
        options?: { id?: string; ownerId?: string },
      ): string {
        const abort = new AbortController();
        const progress: FakeJobCall["progress"] = [];
        const jobId = `job-${calls.length + 1}`;
        const result = run({
          jobId,
          signal: abort.signal,
          reportProgress: async (text, details) => {
            progress.push({ text, details });
          },
          markRunning: () => undefined,
        });
        calls.push({ type, label, options, result, abort, progress });
        return jobId;
      },
    };
  }

  const followClient = {
    listDirectChannels: async () => [{ id: "dm-1", recipients: [{ id: "user-1" }], type: 1 }],
    listMessages: async () => [
      {
        content: "baseline",
        id: "message-1",
        timestamp: "2026-07-19T12:00:00.000Z",
      },
    ],
  } as unknown as DiscordClient;
  const dmTarget = { kind: "dm", channelId: "dm-1", recipientId: "user-1" };

  test("start registers one visible background job", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "omp-discord-follow-job-"));
    roots.push(cacheRoot);
    const tools = new Map<string, RegisteredTool>();
    const calls: FakeJobCall[] = [];
    createDiscordExtension(extensionApi(tools), {
      cacheRoot,
      client: followClient,
      jobRegistry: fakeJobRegistry(calls),
    });

    await execute(tools, "discord_follow_start", { target: dmTarget }, "session-a");
    expect(calls.length).toBe(1);
    expect(calls[0]?.type).toBe("task");
    expect(calls[0]?.options?.ownerId).toBe("Main");
    expect(calls[0]?.label).toContain("Discord follow");
    expect(calls[0]?.label).toContain("dm-1");

    await execute(tools, "discord_follow_start", { resume: true }, "session-a");
    expect(calls.length).toBe(1);
  });

  test("stop completes the job with a delivery summary", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "omp-discord-follow-job-"));
    roots.push(cacheRoot);
    const tools = new Map<string, RegisteredTool>();
    const calls: FakeJobCall[] = [];
    createDiscordExtension(extensionApi(tools), {
      cacheRoot,
      client: followClient,
      jobRegistry: fakeJobRegistry(calls),
    });

    await execute(tools, "discord_follow_start", { target: dmTarget }, "session-a");
    await execute(tools, "discord_follow_stop", {}, "session-a");

    const summary = await calls[0]?.result;
    expect(summary).toContain("stopped");
    expect(summary).toContain("0 messages");
  });

  test("cancelling the job stops the follow", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "omp-discord-follow-job-"));
    roots.push(cacheRoot);
    const tools = new Map<string, RegisteredTool>();
    const calls: FakeJobCall[] = [];
    createDiscordExtension(extensionApi(tools), {
      cacheRoot,
      client: followClient,
      jobRegistry: fakeJobRegistry(calls),
    });

    await execute(tools, "discord_follow_start", { target: dmTarget }, "session-a");
    calls[0]?.abort.abort();

    // The job result resolves only after the abort listener's stopFollow completes.
    expect(await calls[0]?.result).toContain("stopped");
    const status = (await execute(tools, "discord_follow_status", {}, "session-a")) as {
      details: { enabled: boolean };
    };
    expect(status.details.enabled).toBe(false);
  });

  test("null jobRegistry disables registration without breaking follow", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "omp-discord-follow-job-"));
    roots.push(cacheRoot);
    const tools = new Map<string, RegisteredTool>();
    createDiscordExtension(extensionApi(tools), {
      cacheRoot,
      client: followClient,
      jobRegistry: null,
    });

    const started = (await execute(
      tools,
      "discord_follow_start",
      { target: dmTarget },
      "session-a",
    )) as {
      details: { enabled: boolean };
    };
    expect(started.details.enabled).toBe(true);
    const stopped = (await execute(tools, "discord_follow_stop", {}, "session-a")) as {
      details: { enabled: boolean };
    };
    expect(stopped.details.enabled).toBe(false);
  });
});

describe("Discord follow delivery", () => {
  test("delivers plugin steering batches with attachment links", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "omp-discord-follow-deliver-"));
    roots.push(cacheRoot);
    const configPath = join(cacheRoot, "discord.yml");
    await writeFile(configPath, "follow:\n  batch_size: 1\n  poll_ms: 250\n", "utf8");

    const tools = new Map<string, RegisteredTool>();
    const sent: Array<{
      message: { customType?: string; content?: string; attribution?: string };
      options?: { deliverAs?: string; triggerTurn?: boolean };
    }> = [];
    const pi = {
      zod: z,
      setLabel: () => undefined,
      registerCommand: () => undefined,
      registerTool: (tool: RegisteredTool) => {
        if (tool.name) tools.set(tool.name, tool);
      },
      logger: { warn: () => undefined, debug: () => undefined },
      sendMessage: (
        message: {
          customType?: string;
          content?: string;
          attribution?: string;
        },
        options?: { deliverAs?: string; triggerTurn?: boolean },
      ) => {
        sent.push({ message, options });
      },
    } as unknown as ExtensionAPI;

    let scheduledTick: (() => void) | undefined;
    const timerContext = {
      sessionManager: { getSessionId: () => "session-a" },
      setTimeout: (callback: () => void) => {
        scheduledTick = callback;
        return Symbol("timer");
      },
      clearTimer: () => undefined,
    } as unknown as ExtensionContext;

    let calls = 0;
    const client = {
      listDirectChannels: async () => [{ id: "dm-1", recipients: [{ id: "user-1" }], type: 1 }],
      listMessages: async () => {
        calls += 1;
        const baseline = {
          content: "baseline",
          id: "100",
          timestamp: "2026-07-23T10:00:00.000Z",
        };
        if (calls === 1) return [baseline];
        return [
          baseline,
          {
            content: "look at this image",
            id: "200",
            timestamp: "2026-07-23T10:01:00.000Z",
            attachments: [
              {
                id: "att-1",
                filename: "image.png",
                content_type: "image/png",
                size: 180,
                width: 14,
                height: 10,
                url: "https://cdn.discordapp.com/attachments/dm-1/att-1/image.png",
              },
            ],
          },
        ];
      },
    } as unknown as DiscordClient;

    createDiscordExtension(pi, {
      cacheRoot,
      client,
      configPath,
      jobRegistry: null,
    });

    const start = tools.get("discord_follow_start");
    if (!start?.parameters) throw new Error("missing discord_follow_start");
    await (start.execute as (...args: unknown[]) => Promise<unknown>)(
      "call",
      start.parameters.parse({
        target: { kind: "dm", channelId: "dm-1", recipientId: "user-1" },
      }),
      new AbortController().signal,
      undefined,
      timerContext,
    );
    if (!scheduledTick) throw new Error("timer was not armed");

    scheduledTick();
    for (let attempt = 0; attempt < 200 && sent.length === 0; attempt++) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      await promise;
    }

    expect(sent.length).toBe(1);
    expect(sent[0]?.message.customType).toBe("discord-follow");
    expect(sent[0]?.message.attribution).toBeUndefined();
    expect(sent[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    const payload = sent[0]?.message.content ?? "";
    expect(payload).toContain("look at this image");
    expect(payload).toContain("https://cdn.discordapp.com/attachments/dm-1/att-1/image.png");

    // The list tool must keep stripping CDN urls even for the same client data.
    const list = tools.get("discord_list_messages");
    if (!list?.parameters) throw new Error("missing discord_list_messages");
    const listed = (await (list.execute as (...args: unknown[]) => Promise<unknown>)(
      "call",
      list.parameters.parse({
        limit: 5,
        target: { kind: "dm", channelId: "dm-1", recipientId: "user-1" },
      }),
      new AbortController().signal,
      undefined,
      timerContext,
    )) as { content: Array<{ text: string }> };
    expect(listed.content[0]?.text).not.toContain("cdn.discordapp.com");
  });
});
