import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type DiscordTarget =
  | { kind: "guild"; guildId: string; channelId: string }
  | { kind: "dm"; channelId: string; recipientId: string }
  | { kind: "group-dm"; channelId: string; recipientIds: string[] };

export interface SentMessage {
  messageId: string;
  target: DiscordTarget;
  content: string;
  createdAt: string;
  updatedAt: string;
  editedAt?: string;
  deleted?: boolean;
}

export interface OperationResult {
  count?: number;
  entityIds?: string[];
  messageIds?: string[];
  status?: string;
}

export interface OperationRecord {
  action: string;
  target?: DiscordTarget;
  occurredAt: string;
  result: OperationResult;
}

/** Strict structural equality for Discord targets across every field. */
export function targetsMatch(
  left: DiscordTarget,
  right: DiscordTarget,
): boolean {
  if (left.kind !== right.kind || left.channelId !== right.channelId)
    return false;
  if (left.kind === "guild" && right.kind === "guild")
    return left.guildId === right.guildId;
  if (left.kind === "dm" && right.kind === "dm")
    return left.recipientId === right.recipientId;
  if (left.kind === "group-dm" && right.kind === "group-dm") {
    return (
      left.recipientIds.length === right.recipientIds.length &&
      left.recipientIds.every((recipientId) =>
        right.recipientIds.includes(recipientId),
      )
    );
  }
  return false;
}

const SELECTION_CACHE_DIRECTORY = "message-selection-cache";
const OPERATION_DIRECTORY = "operations";

function sessionFilename(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTarget(value: unknown): value is DiscordTarget {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    typeof value.channelId !== "string"
  )
    return false;
  if (value.kind === "guild") return typeof value.guildId === "string";
  if (value.kind === "dm") return typeof value.recipientId === "string";
  return (
    value.kind === "group-dm" &&
    Array.isArray(value.recipientIds) &&
    value.recipientIds.every((id) => typeof id === "string")
  );
}

function isSentMessage(value: unknown): value is SentMessage {
  return (
    isRecord(value) &&
    typeof value.messageId === "string" &&
    isTarget(value.target) &&
    typeof value.content === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.editedAt === undefined || typeof value.editedAt === "string") &&
    (value.deleted === undefined || typeof value.deleted === "boolean")
  );
}

function isOperationResult(value: unknown): value is OperationResult {
  return (
    isRecord(value) &&
    (value.count === undefined || typeof value.count === "number") &&
    (value.status === undefined || typeof value.status === "string") &&
    (value.entityIds === undefined ||
      (Array.isArray(value.entityIds) &&
        value.entityIds.every((id) => typeof id === "string"))) &&
    (value.messageIds === undefined ||
      (Array.isArray(value.messageIds) &&
        value.messageIds.every((id) => typeof id === "string")))
  );
}

function isOperationRecord(value: unknown): value is OperationRecord {
  return (
    isRecord(value) &&
    typeof value.action === "string" &&
    typeof value.occurredAt === "string" &&
    (value.target === undefined || isTarget(value.target)) &&
    isOperationResult(value.result)
  );
}

function dataPath(root: string, directory: string, sessionId: string): string {
  return join(root, directory, `${sessionFilename(sessionId)}.json`);
}

async function readJsonArray<T>(
  root: string,
  directory: string,
  sessionId: string,
  predicate: (value: unknown) => value is T,
  description: string,
): Promise<T[]> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(dataPath(root, directory, sessionId), "utf8"),
    );
    if (!Array.isArray(parsed) || !parsed.every(predicate))
      throw new Error(`Discord session ${description} is invalid`);
    return parsed;
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeJsonArray<T>(
  root: string,
  directory: string,
  sessionId: string,
  values: T[],
): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const targetDirectory = join(root, directory);
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  await chmod(targetDirectory, 0o700);
  const destination = dataPath(root, directory, sessionId);
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(values)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, destination);
}

async function readMessages(
  root: string,
  directory: string,
  sessionId: string,
): Promise<SentMessage[]> {
  return readJsonArray(
    root,
    directory,
    sessionId,
    isSentMessage,
    "message cache",
  );
}

async function writeMessages(
  root: string,
  directory: string,
  sessionId: string,
  messages: SentMessage[],
): Promise<void> {
  await writeJsonArray(root, directory, sessionId, messages);
}

export async function listCachedMessages(
  root: string,
  sessionId: string,
): Promise<SentMessage[]> {
  return readMessages(root, SELECTION_CACHE_DIRECTORY, sessionId);
}

export async function cacheListedMessages(
  root: string,
  sessionId: string,
  listed: SentMessage[],
): Promise<void> {
  const messages = await listCachedMessages(root, sessionId);
  for (const message of listed) {
    const index = messages.findIndex(
      (entry) => entry.messageId === message.messageId,
    );
    if (index === -1) messages.push(message);
    else
      messages[index] = {
        ...messages[index],
        ...message,
        deleted: messages[index]?.deleted ?? message.deleted,
      };
  }
  await writeMessages(root, SELECTION_CACHE_DIRECTORY, sessionId, messages);
}

export async function updateCachedMessage(
  root: string,
  sessionId: string,
  messageId: string,
  patch: Partial<
    Pick<SentMessage, "content" | "updatedAt" | "editedAt" | "deleted">
  >,
): Promise<void> {
  const messages = await listCachedMessages(root, sessionId);
  const index = messages.findIndex((entry) => entry.messageId === messageId);
  if (index === -1)
    throw new Error(
      `Discord message ${messageId} is not in this OMP session's cached message list`,
    );
  messages[index] = { ...messages[index], ...patch };
  await writeMessages(root, SELECTION_CACHE_DIRECTORY, sessionId, messages);
}

export async function listOperations(
  root: string,
  sessionId: string,
): Promise<OperationRecord[]> {
  return readJsonArray(
    root,
    OPERATION_DIRECTORY,
    sessionId,
    isOperationRecord,
    "operation ledger",
  );
}

export async function appendOperation(
  root: string,
  sessionId: string,
  operation: OperationRecord,
): Promise<void> {
  const operations = await listOperations(root, sessionId);
  operations.push(operation);
  await writeJsonArray(root, OPERATION_DIRECTORY, sessionId, operations);
}
