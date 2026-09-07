import { randomUUID } from "crypto";
import { listKeys, readJson, writeJson, removeKey } from "@/lib/storage";
import type {
  Conversation,
  ConversationMeta,
  StoredMessage,
} from "@/types";

// 会话存储：经存储抽象层（本地 data/ 或 Cloudflare R2，见 lib/storage.ts）

function convKey(id: string) {
  // 防止路径穿越
  return `conversations/${id.replace(/[^a-zA-Z0-9_-]/g, "")}.json`;
}

export async function createConversation(ownerId?: string): Promise<Conversation> {
  const now = Date.now();
  const conv: Conversation = {
    id: randomUUID(),
    title: "新对话",
    ownerId: ownerId || undefined,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  await writeJson(convKey(conv.id), conv);
  return conv;
}

export async function getConversation(id: string): Promise<Conversation | null> {
  return readJson<Conversation | null>(convKey(id), null);
}

/** 归属校验：有主会话只能被本人读写；无主（历史/未登录）对所有匿名会话开放 */
export function canAccess(conv: Conversation | null, ownerId?: string): boolean {
  if (!conv) return false;
  if (!conv.ownerId) return true;
  return Boolean(ownerId) && conv.ownerId === ownerId;
}

export async function listConversations(ownerId?: string): Promise<ConversationMeta[]> {
  const items = await listKeys("conversations/");
  const metas: ConversationMeta[] = [];
  for (const item of items) {
    if (!item.key.endsWith(".json")) continue;
    try {
      const c = await readJson<Conversation>(item.key, null as unknown as Conversation);
      if (!c?.id) continue;
      // 登录：只看自己的；未登录：只看无主的。互相都看不到对方的会话。
      const visible = ownerId ? c.ownerId === ownerId : !c.ownerId;
      if (!visible) continue;
      metas.push({
        id: c.id,
        title: c.title,
        ownerId: c.ownerId,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt || item.lastModified || 0,
        messageCount: c.messages?.length || 0,
      });
    } catch {
      // 跳过损坏文件
    }
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function appendMessage(
  conversationId: string,
  message: StoredMessage
): Promise<Conversation | null> {
  const conv = await getConversation(conversationId);
  if (!conv) return null;
  conv.messages.push(message);
  conv.updatedAt = Date.now();
  await writeJson(convKey(conversationId), conv);
  return conv;
}

export async function setTitle(conversationId: string, title: string): Promise<void> {
  const conv = await getConversation(conversationId);
  if (!conv) return;
  conv.title = title;
  await writeJson(convKey(conversationId), conv);
}

export async function deleteConversation(id: string): Promise<void> {
  await removeKey(convKey(id));
}
