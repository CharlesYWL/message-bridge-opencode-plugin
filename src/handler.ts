import type { OpenCodeApi } from './opencode';
import type { FeishuClient } from './feishu';
import { LOADING_EMOJI } from './constants';
import type { Part } from '@opencode-ai/sdk';

// --- 类型定义 ---
interface SessionContext {
  chatId: string;
  senderId: string;
}

interface MessageBuffer {
  feishuMsgId: string | null; // 飞书侧的消息 ID
  fullContent: string; // 本地累积的完整内容
  type: 'text' | 'reasoning';
  lastUpdateTime: number; // 上次调用飞书 API 的时间
  isFinished: boolean;
}

// --- 全局状态 ---
// 1. 路由表
const sessionToFeishuMap = new Map<string, SessionContext>();
// 2. 消息缓冲区
const messageBuffers = new Map<string, MessageBuffer>();

// 3. 节流间隔 (毫秒)
const UPDATE_INTERVAL = 800;
// 4. 监听器锁
let isListenerStarted = false;
let shouldStopListener = false;

// --- 核心功能 1: 全局事件监听器 ---
export async function startGlobalEventListener(api: OpenCodeApi, feishu: FeishuClient) {
  if (isListenerStarted) return;
  isListenerStarted = true;
  shouldStopListener = false;

  console.log('[Listener] 🎧 Starting Global Event Subscription...');

  let retryCount = 0;

  const connect = async () => {
    try {
      const events = await api.event.subscribe();
      console.log('[Listener] ✅ Connected to OpenCode Event Stream');
      retryCount = 0;

      for await (const event of events.stream) {
        if (shouldStopListener) {
          console.log('[Listener] 🛑 Loop terminated.');
          break;
        }

        if (event.type === 'message.part.updated') {
          // 获取核心数据
          const sessionId = event.properties.part.sessionID;
          const part = event.properties.part;

          // 🔥 关键修复 1: 获取增量数据 delta 🔥
          // SDK 的 event.properties 里通常包含 delta 字段
          const delta = (event.properties as any).delta;

          if (!sessionId || !part) continue;

          const context = sessionToFeishuMap.get(sessionId);
          if (!context) continue;

          const msgId = part.messageID;

          if (part.type === 'text' || part.type === 'reasoning') {
            // 将 delta 传给处理函数
            await handleStreamUpdate(feishu, context.chatId, msgId, part, delta);
          } else if (part.type === 'tool') {
            if (part.state?.status === 'running') {
              // 可选：打印日志或通知
              console.log(`[Listener] 🔧 Tool Running: ${part.tool}`);
            }
          }
        } else if (event.type === 'session.deleted' || event.type === 'session.error') {
          const sid = (event.properties as any).sessionID;
          if (sid) sessionToFeishuMap.delete(sid);
        }
      }
    } catch (error) {
      if (shouldStopListener) return;
      console.error('[Listener] ❌ Stream Disconnected:', error);
      const delay = Math.min(5000 * (retryCount + 1), 60000);
      retryCount++;
      setTimeout(connect, delay);
    }
  };

  connect();
}

export function stopGlobalEventListener() {
  shouldStopListener = true;
  isListenerStarted = false;
  sessionToFeishuMap.clear();
  messageBuffers.clear();
}

// 辅助函数：处理流式更新
async function handleStreamUpdate(
  feishu: FeishuClient,
  chatId: string,
  msgId: string,
  part: Part,
  delta?: string // 🔥 新增参数
) {
  if (!msgId) return;
  if (part.type !== 'text' && part.type !== 'reasoning') return;

  // 获取或初始化 Buffer
  let buffer = messageBuffers.get(msgId);
  if (!buffer) {
    buffer = {
      feishuMsgId: null,
      fullContent: '',
      type: part.type,
      lastUpdateTime: 0,
      isFinished: false,
    };
    messageBuffers.set(msgId, buffer);
  }

  // 🔥 关键修复 2: 优先使用 Delta 追加，否则使用全量覆盖 🔥
  if (typeof delta === 'string' && delta.length > 0) {
    // 情况 A: 有增量，追加
    buffer.fullContent += delta;
  } else if (typeof part.text === 'string') {
    // 情况 B: 无增量，可能是第一帧或者全量包
    // 只有当 part.text 比当前 buffer 长的时候才覆盖，防止旧数据覆盖新数据
    if (part.text.length >= buffer.fullContent.length) {
      buffer.fullContent = part.text;
    }
  }

  // 节流与更新逻辑
  const now = Date.now();
  const shouldUpdate = !buffer.feishuMsgId || now - buffer.lastUpdateTime > UPDATE_INTERVAL;

  if (shouldUpdate && buffer.fullContent) {
    buffer.lastUpdateTime = now;

    let displayContent = buffer.fullContent;
    if (buffer.type === 'reasoning') {
      displayContent = `🤔 思考中...\n\n${displayContent}`;
    }

    try {
      if (!buffer.feishuMsgId) {
        const sentId = await feishu.sendMessage(chatId, displayContent);
        if (sentId) buffer.feishuMsgId = sentId;
      } else {
        await feishu.editMessage(chatId, buffer.feishuMsgId, displayContent);
      }
    } catch (e) {
      console.error(`[Listener] Failed to update Feishu msg:`, e);
    }
  }
}

// --- 核心功能 2: 极简消息处理器 ---
const sessionCache = new Map<string, string>();

export const createMessageHandler = (api: OpenCodeApi, feishu: FeishuClient) => {
  return async (chatId: string, text: string, messageId: string, senderId: string) => {
    console.log(`[Bridge] 📥 Incoming: "${text}"`);

    if (text.trim().toLowerCase() === 'ping') {
      await feishu.sendMessage(chatId, 'Pong! ⚡️');
      return;
    }

    let reactionId: string | null = null;

    try {
      if (messageId) {
        reactionId = await feishu.addReaction(messageId, LOADING_EMOJI);
      }

      let sessionId = sessionCache.get(chatId);
      if (!sessionId) {
        const uniqueTitle = `Chat ${chatId.slice(-4)} [${new Date().toLocaleTimeString()}]`;
        const res = await api.createSession({ body: { title: uniqueTitle } });
        sessionId = res.data?.id;

        if (sessionId) {
          sessionCache.set(chatId, sessionId);
        }
      }

      if (!sessionId) throw new Error('Failed to init Session');

      // 注册路由
      sessionToFeishuMap.set(sessionId, { chatId, senderId });

      // 发送请求
      await api.promptSession({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text: text }] },
      });

      console.log(`[Bridge] 🚀 Prompt Sent.`);
    } catch (error: any) {
      console.error('[Bridge] ❌ Error:', error);
      if (error.status === 404) sessionCache.delete(chatId);
      await feishu.sendMessage(chatId, `❌ Error: ${error.message}`);
    } finally {
      if (messageId && reactionId) {
        await feishu.removeReaction(messageId, reactionId).catch(() => {});
      }
    }
  };
};
