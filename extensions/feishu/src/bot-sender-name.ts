import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createFeishuClient } from "./client.js";
import type { ResolvedFeishuAccount } from "./types.js";

export type FeishuPermissionError = {
  code: number;
  message: string;
  grantUrl?: string;
};

type SenderNameResult = {
  name?: string;
  permissionError?: FeishuPermissionError;
};

type FeishuContactUserGetResponse = Awaited<
  ReturnType<ReturnType<typeof createFeishuClient>["contact"]["user"]["get"]>
>;

type FeishuLogger = (...args: unknown[]) => void;

const IGNORED_PERMISSION_SCOPE_TOKENS = ["contact:contact.base:readonly"];
const FEISHU_SCOPE_CORRECTIONS: Record<string, string> = {
  "contact:contact.base:readonly": "contact:user.base:readonly",
};
const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const senderNameCache = new Map<string, { name: string; expireAt: number }>();

function correctFeishuScopeInUrl(url: string): string {
  let corrected = url;
  for (const [wrong, right] of Object.entries(FEISHU_SCOPE_CORRECTIONS)) {
    corrected = corrected.replaceAll(encodeURIComponent(wrong), encodeURIComponent(right));
    corrected = corrected.replaceAll(wrong, right);
  }
  return corrected;
}

function shouldSuppressPermissionErrorNotice(permissionError: FeishuPermissionError): boolean {
  const message = normalizeLowercaseStringOrEmpty(permissionError.message);
  return IGNORED_PERMISSION_SCOPE_TOKENS.some((token) => message.includes(token));
}

function extractPermissionError(err: unknown): FeishuPermissionError | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const axiosErr = err as { response?: { data?: unknown } };
  const data = axiosErr.response?.data;
  if (!data || typeof data !== "object") {
    return null;
  }
  const feishuErr = data as { code?: number; msg?: string };
  if (feishuErr.code !== 99991672) {
    return null;
  }
  const msg = feishuErr.msg ?? "";
  const urlMatch = msg.match(/https:\/\/[^\s,]+\/app\/[^\s,]+/);
  return {
    code: feishuErr.code,
    message: msg,
    grantUrl: urlMatch?.[0] ? correctFeishuScopeInUrl(urlMatch[0]) : undefined,
  };
}

function resolveSenderLookupIdType(senderId: string): "open_id" | "user_id" | "union_id" {
  const trimmed = senderId.trim();
  if (trimmed.startsWith("ou_")) {
    return "open_id";
  }
  if (trimmed.startsWith("on_")) {
    return "union_id";
  }
  return "user_id";
}

export async function resolveFeishuSenderName(params: {
  account: ResolvedFeishuAccount;
  senderId: string;
  chatId?: string;
  isGroup?: boolean;
  log: FeishuLogger;
}): Promise<SenderNameResult> {
  const { account, senderId, log } = params;
  if (!account.configured) {
    return {};
  }

  const normalizedSenderId = senderId.trim();
  if (!normalizedSenderId) {
    return {};
  }

  const cached = senderNameCache.get(normalizedSenderId);
  const now = Date.now();
  if (cached && cached.expireAt > now) {
    return { name: cached.name };
  }

  try {
    const client = createFeishuClient(account);
    const userIdType = resolveSenderLookupIdType(normalizedSenderId);
    const res: FeishuContactUserGetResponse = await client.contact.user.get({
      path: { user_id: normalizedSenderId },
      params: { user_id_type: userIdType },
    });
    const user = res.data?.user;
    const name = user?.name ?? user?.nickname ?? user?.en_name;

    if (name) {
      senderNameCache.set(normalizedSenderId, { name, expireAt: now + SENDER_NAME_TTL_MS });
      return { name };
    }
    return {};
  } catch (err) {
    const permErr = extractPermissionError(err);
    if (permErr) {
      if (shouldSuppressPermissionErrorNotice(permErr)) {
        log(`feishu: ignoring stale permission scope error: ${permErr.message}`);
        return {};
      }
      log(`feishu: permission error resolving sender name: code=${permErr.code}`);
      return { permissionError: permErr };
    }
    const groupMemberName = await resolveSenderNameFromChatMembers({
      account,
      chatId: params.isGroup ? params.chatId : undefined,
      senderId: normalizedSenderId,
      log,
    });
    if (groupMemberName) {
      senderNameCache.set(normalizedSenderId, {
        name: groupMemberName,
        expireAt: now + SENDER_NAME_TTL_MS,
      });
      return { name: groupMemberName };
    }
    // Surface the full Feishu error body (code/msg) — axios status alone (400)
    // can't tell a missing contact scope from an out-of-visibility open_id.
    const errBody = (err as { response?: { data?: unknown } })?.response?.data;
    log(
      `feishu: failed to resolve sender name for ${normalizedSenderId} (idType=${resolveSenderLookupIdType(
        normalizedSenderId,
      )}): ${String(err)}${errBody ? ` body=${JSON.stringify(errBody)}` : ""}`,
    );
    return {};
  }
}

async function resolveSenderNameFromChatMembers(params: {
  account: ResolvedFeishuAccount;
  chatId?: string;
  senderId: string;
  log: FeishuLogger;
}): Promise<string | undefined> {
  const chatId = params.chatId?.trim();
  if (!chatId) {
    return undefined;
  }

  try {
    const client = createFeishuClient(params.account);
    const memberIdType = resolveSenderLookupIdType(params.senderId);
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const res = await client.im.chatMembers.get({
        path: { chat_id: chatId },
        params: {
          page_size: 100,
          page_token: pageToken,
          member_id_type: memberIdType,
        },
      });
      if (res.code !== 0) {
        params.log(`feishu: failed to resolve sender name from chat members: ${res.msg}`);
        return undefined;
      }
      const match = res.data?.items?.find((member) => member.member_id === params.senderId);
      const name = match?.name?.trim();
      if (name) {
        return name;
      }
      const nextPageToken = res.data?.page_token?.trim();
      if (!res.data?.has_more || !nextPageToken) {
        return undefined;
      }
      pageToken = nextPageToken;
    }
    params.log(`feishu: sender name chat member lookup exhausted for chat ${chatId}`);
  } catch (err) {
    params.log(`feishu: failed to resolve sender name from chat members: ${String(err)}`);
  }
  return undefined;
}
