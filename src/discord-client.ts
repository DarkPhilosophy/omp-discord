export type DiscordFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CredentialProvider {
  get(): Promise<string | undefined>;
}

export interface DiscordClientOptions {
  credential: CredentialProvider;
  fetch?: DiscordFetch;
  apiBaseUrl?: string;
}

export interface DiscordAttachmentMetadata {
  id: string;
  filename: string;
  contentType?: string;
  size: number;
  width?: number;
  height?: number;
  /** CDN link; populated only where the caller opts in (e.g. follow notifications). */
  url?: string;
}

export interface DiscordAttachmentRead {
  attachment: DiscordAttachmentMetadata;
  data: Uint8Array;
}

export interface DiscordAttachmentLimits {
  imageMaxBytes: number;
  textMaxBytes: number;
  fileMaxBytes: number;
}

interface DiscordAttachmentRecord {
  metadata: DiscordAttachmentMetadata;
  url: string;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function attachmentRecord(value: unknown): DiscordAttachmentRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const attachment = value as Record<string, unknown>;
  if (
    typeof attachment.id !== "string" ||
    typeof attachment.filename !== "string" ||
    typeof attachment.url !== "string"
  )
    return undefined;
  const size = optionalNonNegativeInteger(attachment.size);
  if (size === undefined) return undefined;
  return {
    metadata: {
      id: attachment.id,
      filename: attachment.filename,
      ...(typeof attachment.content_type === "string"
        ? { contentType: attachment.content_type }
        : {}),
      size,
      ...(optionalNonNegativeInteger(attachment.width) === undefined
        ? {}
        : { width: optionalNonNegativeInteger(attachment.width) }),
      ...(optionalNonNegativeInteger(attachment.height) === undefined
        ? {}
        : { height: optionalNonNegativeInteger(attachment.height) }),
    },
    url: attachment.url,
  };
}

export function discordAttachmentMetadata(value: unknown): DiscordAttachmentMetadata | undefined {
  return attachmentRecord(value)?.metadata;
}

function isTrustedAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "cdn.discordapp.com" || url.hostname === "media.discordapp.net")
    );
  } catch {
    return false;
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Discord attachment response exceeds the ${maxBytes} byte limit`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Discord attachment response exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array();
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

export class DiscordHttpError extends Error {
  constructor(
    readonly status: number,
    options: { retryAfterMs?: number; detail?: string } = {},
  ) {
    super(
      `Discord request failed with HTTP ${status}${options.detail ? `: ${options.detail}` : ""}`,
    );
    this.name = "DiscordHttpError";
    this.retryAfterMs = options.retryAfterMs;
    this.detail = options.detail;
  }

  /** Milliseconds Discord asked us to wait before retrying (429 only). */
  readonly retryAfterMs?: number;
  /** Short error detail from the Discord response body, if parseable. */
  readonly detail?: string;
}

/** Builds a DiscordHttpError with retry-after and a short body detail when parseable. */
async function httpError(response: Response): Promise<DiscordHttpError> {
  let retryAfterMs: number | undefined;
  let detail: string | undefined;
  try {
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.message === "string" && body.message.length > 0) {
      detail = body.message.slice(0, 200);
    }
    if (response.status === 429 && typeof body.retry_after === "number") {
      retryAfterMs = Math.ceil(body.retry_after * 1000);
    }
  } catch {
    // Non-JSON error bodies keep the plain status error.
  }
  if (retryAfterMs === undefined && response.status === 429) {
    const header = Number(response.headers.get("retry-after"));
    if (Number.isFinite(header) && header > 0) retryAfterMs = Math.ceil(header * 1000);
  }
  return new DiscordHttpError(response.status, { retryAfterMs, detail });
}

export class DiscordClient {
  readonly #credential: CredentialProvider;
  readonly #fetch: DiscordFetch;
  readonly #apiBaseUrl: string;

  constructor({
    credential,
    fetch = globalThis.fetch,
    apiBaseUrl = "https://discord.com/api/v10",
  }: DiscordClientOptions) {
    this.#credential = credential;
    this.#fetch = fetch;
    this.#apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
  }

  async getCurrentUser(): Promise<unknown> {
    return this.#request("/users/@me");
  }
  async validateCredential(token: string): Promise<unknown> {
    return this.#request("/users/@me", {}, token);
  }

  async listGuilds(): Promise<unknown[]> {
    return this.#request("/users/@me/guilds") as Promise<unknown[]>;
  }

  async listGuildChannels(guildId: string): Promise<unknown[]> {
    return this.#request(`/guilds/${encodeURIComponent(guildId)}/channels`) as Promise<unknown[]>;
  }

  async listDirectChannels(): Promise<unknown[]> {
    return this.#request("/users/@me/channels") as Promise<unknown[]>;
  }

  async listMessages(channelId: string, limit: number, after?: string): Promise<unknown[]> {
    const query = after ? `limit=${limit}&after=${encodeURIComponent(after)}` : `limit=${limit}`;
    return this.#request(`/channels/${encodeURIComponent(channelId)}/messages?${query}`) as Promise<
      unknown[]
    >;
  }

  async sendMessage(channelId: string, content: string): Promise<unknown> {
    return this.#request(`/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<unknown> {
    return this.#request(
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ content }),
      },
    );
  }

  deleteMessage(channelId: string, messageId: string): Promise<unknown> {
    return this.#request(
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE" },
    );
  }

  /**
   * Resolves attachment metadata before downloading so the narrowest configured
   * content-type limit is enforced without first allocating up to the file cap.
   */
  async readAttachment(
    channelId: string,
    messageId: string,
    attachmentId: string,
    limits: number | DiscordAttachmentLimits,
    signal?: AbortSignal,
  ): Promise<DiscordAttachmentRead> {
    const configuredLimits =
      typeof limits === "number"
        ? [limits]
        : [limits.imageMaxBytes, limits.textMaxBytes, limits.fileMaxBytes];
    if (configuredLimits.some((limit) => !Number.isSafeInteger(limit) || limit <= 0)) {
      throw new Error("Discord attachment byte limits must be positive integers");
    }
    const message = await this.#request(
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
    );
    const attachments =
      message && typeof message === "object"
        ? (message as Record<string, unknown>).attachments
        : undefined;
    const record = Array.isArray(attachments)
      ? attachments.map(attachmentRecord).find((item) => item?.metadata.id === attachmentId)
      : undefined;
    if (!record) throw new Error("Discord attachment not found on the selected message");
    const maxBytes =
      typeof limits === "number"
        ? limits
        : record.metadata.contentType?.startsWith("image/")
          ? limits.imageMaxBytes
          : record.metadata.contentType?.startsWith("text/")
            ? limits.textMaxBytes
            : limits.fileMaxBytes;
    if (record.metadata.size > maxBytes) {
      throw new Error(
        `Discord attachment size ${record.metadata.size} bytes exceeds the ${maxBytes} byte limit`,
      );
    }
    if (!isTrustedAttachmentUrl(record.url)) {
      throw new Error("Discord attachment has an untrusted download URL");
    }
    const response = await this.#fetch(record.url, {
      method: "GET",
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new DiscordHttpError(response.status);
    return {
      attachment: record.metadata,
      data: await readBoundedBody(response, maxBytes),
    };
  }

  async #request(
    path: string,
    init: RequestInit = {},
    credentialOverride?: string,
  ): Promise<unknown> {
    const token = credentialOverride ?? (await this.#credential.get());
    if (!token) throw new Error("Discord is not connected");

    const response = await this.#fetch(`${this.#apiBaseUrl}${path}`, {
      ...init,
      headers: {
        authorization: token,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) throw await httpError(response);
    if (response.status === 204) return undefined;
    return response.json();
  }
}
