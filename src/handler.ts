import type { TextPartInput } from '@opencode-ai/sdk';
import type { OpenCodeApi } from './opencode';
import type { FeishuClient } from './feishu';
import { LOADING_EMOJI } from './constants';

const sessionMap = new Map<string, string>();
export const sessionOwnerMap = new Map<string, string>();

// 🟢 新增：并发锁队列，确保同一个用户的消息按顺序处理，防止“吞消息”
const chatQueues = new Map<string, Promise<void>>();

// 辅助函数：延迟等待
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const createMessageHandler = (api: OpenCodeApi, feishu: FeishuClient) => {
  return async (chatId: string, text: string, messageId: string, senderId: string) => {
    console.log(`[Bridge] 📥 Received: "${text}" from ${senderId}`);

    // 1. 快速响应 Ping，不进入队列
    if (text.trim().toLowerCase() === 'ping') {
      await feishu.sendMessage(chatId, 'Pong! ⚡️');
      return;
    }

    // 2. ⚡️ 核心机制：加入队列锁
    // 如果当前 chatId 已经在处理消息，则等待上一条处理完毕
    const previousTask = chatQueues.get(chatId) || Promise.resolve();

    // 创建当前任务的控制器
    const currentTask = (async () => {
      // 等待前面的任务完成
      await previousTask.catch(() => {});

      console.log(`[Bridge] 🎬 Processing message: ${messageId}`);
      let reactionId: string | null = null;

      try {
        // 打上 Loading 表情
        if (messageId) {
          reactionId = await feishu.addReaction(messageId, LOADING_EMOJI);
        }

        // --- Session 获取/创建逻辑 (保持原逻辑优化) ---
        let sessionId = sessionMap.get(chatId);

        if (!sessionId) {
          const uniqueSessionTitle = `[Feishu] ${chatId}`;

          // 尝试查找现有 Session
          try {
            if (api.getSessionList) {
              const listRes = await api.getSessionList({ query: { limit: 20 } as any }); // 稍微限制数量
              const sessions = Array.isArray(listRes) ? listRes : listRes.data || [];
              const existSession = sessions.find((s: any) => s.title === uniqueSessionTitle);
              if (existSession) sessionId = existSession.id;
            }
          } catch (e) {
            /* Ignore list error */
          }

          // 创建新 Session
          if (!sessionId) {
            if (!api.createSession) throw new Error('SDK Method: sessionCreate not found');
            const res = await api.createSession({
              body: { title: uniqueSessionTitle, mode: 'plan' },
            });
            sessionId = res.id || res.data?.id;
            console.log(`[Bridge] ✨ New Session Created: ${sessionId}`);
          }

          if (sessionId) {
            sessionMap.set(chatId, sessionId);
            sessionOwnerMap.set(sessionId, senderId);
          }
        } else {
          // 确保 Owner 映射始终存在
          sessionOwnerMap.set(sessionId, senderId);
        }

        if (!sessionId) throw new Error('Failed to acquire Session ID');

        // --- 发送 Prompt ---
        console.log(`[Bridge] 🚀 Prompting AI...`);
        const parts: TextPartInput[] = [{ type: 'text', text: text }];

        try {
          if (!api.promptSession) throw new Error('SDK Method: sessionPrompt not found');
          await api.promptSession({
            path: { id: sessionId },
            body: { parts: parts },
          });
        } catch (err: any) {
          // 如果 404 说明 Session 过期，清除缓存并抛错重试（或者直接提示用户）
          if (JSON.stringify(err).includes('404') || err.status === 404) {
            sessionMap.delete(chatId);
            throw new Error('Session expired. Please retry.');
          }
          throw err;
        }

        // --- ⚡️ 核心修复：轮询直到状态完全完成 ---
        if (!api.getMessages) return;

        let replyText = '';
        let attempts = 0;
        const maxAttempts = 60; // 90秒超时

        while (attempts < maxAttempts) {
          attempts++;
          await sleep(1500); // 每次间隔 1.5秒

          const res: any = await api.getMessages({
            path: { id: sessionId },
            query: { limit: 5 } as any, // 只需要最近几条
          });

          const messages = Array.isArray(res) ? res : res.data || [];
          if (messages.length === 0) continue;

          const lastItem = messages[messages.length - 1];
          const info = lastItem.info || {};

          // 🔍 调试日志：查看当前状态，方便排查
          // console.log(`[Bridge] Polling status: ${info.status}, role: ${info.role}`);

          // ❌ 检查错误
          if (info.error) {
            const errMsg = typeof info.error === 'string' ? info.error : info.error.message;
            throw new Error(`AI Error: ${errMsg}`);
          }

          // ✅ 检查完成状态 (关键修复点)
          // 只有当 status 为 'completed' 时才算真正结束。
          // 单纯判断 role === 'assistant' 是不够的，因为生成过程中 role 也是 assistant。
          const isCompleted = info.status === 'completed';

          if (info.role === 'assistant' && isCompleted) {
            if (lastItem.parts && lastItem.parts.length > 0) {
              replyText = lastItem.parts
                .filter((p: any) => p.type === 'text')
                .map((p: any) => p.text)
                .join('\n')
                .trim();
            }
            break; // 跳出循环
          }
          // 如果还在 generating (status='in_progress' 或其他)，继续循环等待
        }

        if (attempts >= maxAttempts) {
          await feishu.sendMessage(chatId, '❌ AI Response Timeout (90s)');
        } else {
          console.log(`[Bridge] ✅ Reply sent (${replyText.length} chars)`);
          await feishu.sendMessage(chatId, replyText || '(Empty Response)');
        }
      } catch (error: any) {
        console.error('[Bridge] Error:', error);
        await feishu.sendMessage(chatId, `⚠️ Error: ${error.message || 'Unknown error'}`);
      } finally {
        if (messageId && reactionId) {
          await feishu.removeReaction(messageId, reactionId);
        }
      }
    })();

    // 更新队列，将当前任务设为下一个任务的前置依赖
    chatQueues.set(chatId, currentTask);

    // 等待当前任务结束（虽然 createMessageHandler 不需要返回值，但这保证了 Promise 链的完整性）
    return currentTask;
  };
};
