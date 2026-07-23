import { describe, expect, test } from "bun:test";
import { DiscordClient, DiscordHttpError } from "../src/discord-client.ts";

describe("DiscordClient", () => {
  test("uses the local credential only as an authorization header", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new DiscordClient({
      credential: { get: async () => "session-secret" },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify([{ id: "guild-1", name: "OMP" }]), { status: 200 });
      },
    });

    await expect(client.listGuilds()).resolves.toEqual([{ id: "guild-1", name: "OMP" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/users/@me/guilds");
    expect(calls[0]?.init.headers).toMatchObject({ authorization: "session-secret" });
  });

  test("does not issue a request when credentials are unavailable", async () => {
    const client = new DiscordClient({
      credential: { get: async () => undefined },
      fetch: async () => {
        throw new Error("must not request");
      },
    });

    await expect(client.listGuilds()).rejects.toThrow("Discord is not connected");
  });

  test("edits and deletes only the explicitly addressed message", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new DiscordClient({
      credential: { get: async () => "session-secret" },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ id: "message-1", content: "updated" }), { status: 200 });
      },
    });

    await client.editMessage("channel-1", "message-1", "updated");
    await client.deleteMessage("channel-1", "message-1");

    expect(calls.map((call) => [call.url, call.init.method])).toEqual([
      ["https://discord.com/api/v10/channels/channel-1/messages/message-1", "PATCH"],
      ["https://discord.com/api/v10/channels/channel-1/messages/message-1", "DELETE"],
    ]);
    expect(calls[0]?.init.body).toBe(JSON.stringify({ content: "updated" }));
  });

  test("gets the authenticated user without exposing the credential", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new DiscordClient({
      credential: { get: async () => "session-secret" },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Response.json({ id: "me", username: "Alex" });
      },
    });

    await expect(client.getCurrentUser()).resolves.toEqual({ id: "me", username: "Alex" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/users/@me");
    expect(calls[0]?.init.headers).toMatchObject({ authorization: "session-secret" });
  });

  test("validates a supplied credential without persisting or loading one", async () => {
    let credentialReads = 0;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new DiscordClient({
      credential: { get: async () => { credentialReads++; return undefined; } },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Response.json({ id: "me", username: "Alex" });
      },
    });

    await expect(client.validateCredential("direct-credential")).resolves.toEqual({ id: "me", username: "Alex" });
    expect(credentialReads).toBe(0);
    expect(calls[0]?.init.headers).toMatchObject({ authorization: "direct-credential" });
  });

  test("returns HTTP status without response body", async () => {
    const client = new DiscordClient({
      credential: { get: async () => "session-secret" },
      fetch: async () => new Response("sensitive response", { status: 403 }),
    });

    await expect(client.listGuilds()).rejects.toEqual(new DiscordHttpError(403));
  });
  test("downloads only the selected Discord attachment without forwarding authorization", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new DiscordClient({
      credential: { get: async () => "session-secret" },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (calls.length === 1) {
          return Response.json({
            id: "message-1",
            attachments: [{
              id: "attachment-1",
              filename: "notes.txt",
              content_type: "text/plain",
              size: 5,
              url: "https://cdn.discordapp.com/attachments/channel/attachment/notes.txt?signed=yes",
            }],
          });
        }
        return new Response("hello", {
          headers: { "content-length": "5", "content-type": "text/plain" },
        });
      },
    });

    await expect(client.readAttachment(
      "channel-1",
      "message-1",
      "attachment-1",
      10,
    )).resolves.toEqual({
      attachment: {
        id: "attachment-1",
        filename: "notes.txt",
        contentType: "text/plain",
        size: 5,
      },
      data: new Uint8Array(Buffer.from("hello")),
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://discord.com/api/v10/channels/channel-1/messages/message-1",
      "https://cdn.discordapp.com/attachments/channel/attachment/notes.txt?signed=yes",
    ]);
    expect(calls[0]?.init.headers).toMatchObject({ authorization: "session-secret" });
    expect(calls[1]?.init.headers).toBeUndefined();
  });

  test("rejects unsafe, missing, and oversized attachments before returning content", async () => {
    const attachment = {
      id: "attachment-1",
      filename: "archive.bin",
      content_type: "application/octet-stream",
      size: 20,
      url: "https://cdn.discordapp.com/attachments/channel/attachment/archive.bin",
    };
    const client = new DiscordClient({
      credential: { get: async () => "session-secret" },
      fetch: async (url) => String(url).startsWith("https://discord.com/api/")
        ? Response.json({ id: "message-1", attachments: [attachment] })
        : new Response(new Uint8Array(20)),
    });

    await expect(client.readAttachment(
      "channel-1",
      "message-1",
      "missing",
      100,
    )).rejects.toThrow("not found");
    await expect(client.readAttachment(
      "channel-1",
      "message-1",
      "attachment-1",
      10,
    )).rejects.toThrow("20 bytes exceeds");

    attachment.size = 5;
    attachment.url = "https://example.com/payload";
    await expect(client.readAttachment(
      "channel-1",
      "message-1",
      "attachment-1",
      10,
    )).rejects.toThrow("untrusted");
  });

});
