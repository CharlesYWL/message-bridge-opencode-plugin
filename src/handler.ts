import type { TextPartInput } from '@opencode-ai/sdk';
import type { OpenCodeApi } from './opencode';
import type { FeishuClient } from './feishu';
import { LOADING_EMOJI } from './constants';

const sessionMap = new Map<string, string>();
export const sessionOwnerMap = new Map<string, string>();
const chatQueues = new Map<string, Promise<void>>();

const MAX_CONTENT_LENGTH = 500;

export const createMessageHandler = (api: OpenCodeApi, feishu: FeishuClient) => {
  return async (chatId: string, text: string, messageId: string, senderId: string) => {
    console.log(`[Bridge] 📥 Incoming: "${text}"`);

    if (text.trim().toLowerCase() === 'ping') {
      await feishu.sendMessage(chatId, 'Pong! ⚡️');
      return;
    }

    const previousTask = chatQueues.get(chatId) || Promise.resolve();

    const currentTask = (async () => {
      await previousTask.catch(() => {});

      let reactionId: string | null = null;
      try {
        if (messageId) {
          reactionId = await feishu.addReaction(messageId, LOADING_EMOJI);
        }

        let sessionId = sessionMap.get(chatId);
        if (!sessionId) {
          const res = await api.createSession({ body: { title: `Chat ${chatId.slice(-4)}` } });
          sessionId = res.data?.id;
          if (sessionId) {
            sessionMap.set(chatId, sessionId);
            sessionOwnerMap.set(sessionId, senderId);
          }
        }

        if (!sessionId) throw new Error('Session Init Failed');

        console.log(`[Bridge] 🚀 Task Started: ${sessionId}`);

        const res = await api.promptSession({
          path: { id: sessionId },
          body: { parts: [{ type: 'text', text: text }] },
        });

        const assistantParts = res.data?.parts || [];
        let finalResponse = '';

        assistantParts.forEach((part: any, index: number) => {
          const partType = part.type;

          const stagePrefix = '⚙️ [LLM Intermediate Stage - Not Final Result]\n';

          switch (partType) {
            case 'reasoning':
              console.log(`[Bridge] 🧠 Stage: Reasoning`);
              const thought =
                part.text.length > MAX_CONTENT_LENGTH
                  ? `${part.text.substring(
                      0,
                      MAX_CONTENT_LENGTH
                    )}... (Detailed reasoning hidden due to size)`
                  : part.text;
              finalResponse += `${stagePrefix}> 💭 AI Thinking: ${thought}\n\n`;
              break;

            case 'text':
              finalResponse += `${part.text}\n`;
              break;

            case 'tool':
              console.log(`[Bridge] 🔧 Stage: Tooling (${part.tool})`);
              finalResponse += `${stagePrefix}🔧 Calling Tool: \`${part.tool}\` (State: ${part.state})\n\n`;
              break;

            case 'step-start':
              console.log(`[Bridge] 🏁 Stage: Step Start`);
              finalResponse += `${stagePrefix}🚀 Starting execution step...\n\n`;
              break;

            case 'step-finish':
              console.log(`[Bridge] ✅ Stage: Step Finish`);
              finalResponse += `${stagePrefix}✅ Step completed. (Reason: ${part.reason})\n\n`;
              break;

            case 'patch':
              console.log(`[Bridge] 📝 Stage: Patching`);
              finalResponse += `${stagePrefix}📝 Modifying files: \`${part.files?.join(
                ', '
              )}\` (Full diff in background)\n\n`;
              break;

            case 'file':
              console.log(`[Bridge] 📄 Stage: File Export`);
              finalResponse += `📄 Generated File: [${part.filename || 'Download'}](${
                part.url
              })\n\n`;
              break;

            case 'subtask':
              console.log(`[Bridge] 📋 Stage: Subtask`);
              finalResponse += `${stagePrefix}📋 Assigning subtask: ${part.description}\n\n`;
              break;

            case 'snapshot':
              console.log(`[Bridge] 📸 Stage: Snapshot`);
              finalResponse += `${stagePrefix}📸 Environment snapshot taken.\n\n`;
              break;

            default:
              console.log(`[Bridge] ℹ️ Stage: ${partType}`);
          }
        });

        if (finalResponse.trim()) {
          // 在末尾增加一个小的分隔，提示回复结束
          await feishu.sendMessage(chatId, finalResponse.trim());
        }
      } catch (err: any) {
        console.error(`[Bridge] ❌ Error:`, err);
        if (err.status === 404) sessionMap.delete(chatId);
        await feishu.sendMessage(chatId, `❌ Error: ${err.message || 'Unknown error'}`);
      } finally {
        if (messageId && reactionId) {
          await feishu.removeReaction(messageId, reactionId).catch(() => {});
        }
      }
    })();

    chatQueues.set(chatId, currentTask);
    return currentTask;
  };
};
