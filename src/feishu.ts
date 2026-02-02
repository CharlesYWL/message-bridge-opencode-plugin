import * as lark from '@larksuiteoapi/node-sdk';
import * as http from 'http';
import * as crypto from 'crypto';
import type { FeishuConfig } from './types';
import { globalState, processedMessageIds } from './utils';

type MessageHandler = (
  chatId: string,
  text: string,
  messageId: string,
  senderId: string
) => Promise<void>;

/**
 * 🔐 解密飞书事件 (AES-256-CBC)
 */
function decryptEvent(encrypted: string, encryptKey: string): string {
  const key = crypto.createHash('sha256').update(encryptKey).digest();
  const encryptedBuffer = Buffer.from(encrypted, 'base64');
  const iv = encryptedBuffer.subarray(0, 16);
  const ciphertext = encryptedBuffer.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(ciphertext, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export class FeishuClient {
  private apiClient: lark.Client;
  private config: FeishuConfig;
  private wsClient: lark.WSClient | null = null;
  private httpServer: http.Server | null = null;

  constructor(config: FeishuConfig) {
    this.config = config;
    this.apiClient = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });
  }

  // --- Helpers ---

  private isMessageProcessed(messageId: string): boolean {
    if (processedMessageIds.has(messageId)) {
      console.log(`[Feishu] 🚫 Ignoring duplicate message ID: ${messageId}`);
      return true;
    }
    processedMessageIds.add(messageId);
    // 限制缓存大小，防止内存泄漏
    if (processedMessageIds.size > 2000) {
      const first = processedMessageIds.values().next().value;
      processedMessageIds.delete(first);
    }
    return false;
  }

  /**
   * 精确解析消息内容，剔除 @ 机器人占位符，增强错误上报
   */
  private parseAndCleanContent(contentJson: string, mentions?: any[]): string {
    try {
      const content = JSON.parse(contentJson);
      let text: string = content.text || '';

      // 1. 根据 mentions 数组精确剔除占位符 (如 at_1)，避免正则误伤邮箱
      if (mentions && mentions.length > 0) {
        mentions.forEach((m: any) => {
          if (m.key) {
            const regex = new RegExp(m.key, 'g');
            text = text.replace(regex, '');
          }
        });
      }

      // 2. 清理多余空格
      return text.trim();
    } catch (e: any) {
      // 捕获并报告详细错误
      console.error(`[Feishu] ❌ Content Parse Error!`, {
        error: e.message,
        rawContent: contentJson,
      });
      return '';
    }
  }

  // --- Public Methods ---

  public async sendMessage(chatId: string, text: string) {
    try {
      await this.apiClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      console.log(`[Feishu] ✅ Message sent to ${chatId}`);
    } catch (error) {
      console.error('[Feishu] ❌ Failed to send message:', error);
    }
  }

  public async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    try {
      const res = await this.apiClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return res.data?.reaction_id || null;
    } catch (error) {
      console.warn(`[Feishu] Failed to add reaction (${emojiType}):`, error);
      return null;
    }
  }

  public async removeReaction(messageId: string, reactionId: string) {
    if (!reactionId) return;
    try {
      await this.apiClient.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch (error) {
      // 忽略移除失败（可能由于表情已被手动移除）
    }
  }

  /**
   * 启动 WebSocket 监听 (长连接模式)
   */
  public async startWebSocket(onMessage: MessageHandler) {
    if (globalState.__feishu_ws_client_instance) {
      console.log('[Feishu WS] ⚠️ Active connection detected. Skipping.');
      return;
    }

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async data => {
        const { message } = data;
        const messageId = message.message_id;
        const chatId = message.chat_id;
        const senderId = (message as any).sender?.sender_id?.open_id || '';

        if (this.isMessageProcessed(messageId)) return;

        const text = this.parseAndCleanContent(message.content, message.mentions);
        if (!text) return;

        console.log(`[Feishu WS] 📩 Message from ${senderId}: "${text}"`);
        await onMessage(chatId, text, messageId, senderId);
      },
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    globalState.__feishu_ws_client_instance = this.wsClient;
    console.log('✅ Feishu WebSocket Connected!');
  }

  /**
   * 启动 Webhook 服务 (HTTP 模式)
   */
  public async startWebhook(onMessage: MessageHandler) {
    if (this.httpServer) return;

    const port = this.config.port || 8080;
    this.httpServer = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          if (!rawBody) return res.end();

          let body: any = JSON.parse(rawBody);

          // 解密逻辑
          if (body.encrypt && this.config.encryptKey) {
            try {
              const decrypted = decryptEvent(body.encrypt, this.config.encryptKey);
              body = JSON.parse(decrypted);
            } catch (e) {
              console.error('[Feishu Webhook] ❌ Decryption Failed');
              res.writeHead(500);
              return res.end();
            }
          }

          // URL 验证
          if (body.type === 'url_verification') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ challenge: body.challenge }));
          }

          if (body.header?.event_type === 'im.message.receive_v1') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 0 }));

            const event = body.event;
            const messageId = event.message?.message_id;
            const chatId = event.message?.chat_id;
            const senderId = event.sender?.sender_id?.open_id || '';

            if (messageId && chatId && !this.isMessageProcessed(messageId)) {
              const text = this.parseAndCleanContent(event.message.content, event.message.mentions);
              if (text) {
                console.log(`[Feishu Webhook] 📩 Message from ${senderId}: "${text}"`);
                onMessage(chatId, text, messageId, senderId).catch(err => {
                  console.error('[Feishu Webhook] ❌ Handler Error:', err);
                });
              }
            }
            return;
          }

          res.writeHead(200);
          res.end('OK');
        } catch (error) {
          console.error('[Feishu Webhook] ❌ Server Error:', error);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        }
      });
    });

    this.httpServer.listen(port, () => {
      console.log(`✅ Feishu Webhook Server listening on port ${port}`);
    });
  }
}
