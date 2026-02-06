// src/teams/teamsClient.ts
import axios, { AxiosInstance } from 'axios';
import type { IncomingMessageHandler, TeamsConfig } from '../types';
import { globalState, sleep } from '../utils';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Track processed message IDs to avoid duplicates
const processedMessageIds: Set<string> = globalState.__teams_processed_ids || new Set<string>();
globalState.__teams_processed_ids = processedMessageIds;

export class TeamsClient {
  private config: TeamsConfig;
  private axios: AxiosInstance;
  private polling: boolean = false;
  private pollInterval: number;
  private accessToken: string;
  private tokenExpiresAt: number = 0;
  private refreshToken?: string;

  constructor(config: TeamsConfig) {
    this.config = config;
    this.pollInterval = config.poll_interval_ms || 3000;
    this.accessToken = config.access_token || '';
    this.refreshToken = config.refresh_token;

    this.axios = axios.create({
      baseURL: GRAPH_BASE,
      timeout: 30000,
    });

    // Add auth interceptor
    this.axios.interceptors.request.use(async (reqConfig) => {
      await this.ensureValidToken();
      reqConfig.headers.Authorization = `Bearer ${this.accessToken}`;
      return reqConfig;
    });
  }

  private async ensureValidToken(): Promise<void> {
    // If token is still valid (with 60s buffer), return
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return;
    }

    // If we have a refresh token, use it
    if (this.refreshToken && this.config.client_id) {
      await this.refreshAccessToken();
      return;
    }

    // Otherwise use the provided token (may be expired)
    if (!this.accessToken) {
      throw new Error('[Teams] No access token available');
    }
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken || !this.config.client_id) {
      throw new Error('[Teams] Cannot refresh token: missing refresh_token or client_id');
    }

    const tokenUrl = `https://login.microsoftonline.com/${this.config.tenant_id || 'common'}/oauth2/v2.0/token`;

    const params = new URLSearchParams({
      client_id: this.config.client_id,
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      scope: 'Chat.ReadWrite ChatMessage.Send offline_access',
    });

    if (this.config.client_secret) {
      params.append('client_secret', this.config.client_secret);
    }

    try {
      const res = await axios.post(tokenUrl, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      this.accessToken = res.data.access_token;
      this.refreshToken = res.data.refresh_token || this.refreshToken;
      const expiresIn = res.data.expires_in || 3600;
      this.tokenExpiresAt = Date.now() + expiresIn * 1000;

      console.log('[Teams] ✅ Token refreshed successfully');
    } catch (e: any) {
      console.error('[Teams] ❌ Failed to refresh token:', e.response?.data || e.message);
      throw e;
    }
  }

  private isMessageProcessed(messageId: string): boolean {
    if (processedMessageIds.has(messageId)) {
      return true;
    }
    processedMessageIds.add(messageId);
    // Keep set size bounded
    if (processedMessageIds.size > 2000) {
      const first = processedMessageIds.values().next().value || '';
      processedMessageIds.delete(first);
    }
    return false;
  }

  /**
   * List all chats the user is part of
   */
  async listChats(): Promise<any[]> {
    try {
      const res = await this.axios.get('/me/chats', {
        params: { $top: 50 },
      });
      return res.data.value || [];
    } catch (e: any) {
      console.error('[Teams] ❌ Failed to list chats:', e.response?.data || e.message);
      return [];
    }
  }

  /**
   * Get recent messages from a specific chat
   */
  async getMessages(chatId: string, top: number = 10): Promise<any[]> {
    try {
      const res = await this.axios.get(`/me/chats/${chatId}/messages`, {
        params: { $top: top, $orderby: 'createdDateTime desc' },
      });
      return res.data.value || [];
    } catch (e: any) {
      console.error(`[Teams] ❌ Failed to get messages for chat ${chatId}:`, e.response?.data || e.message);
      return [];
    }
  }

  /**
   * Send a message to a chat
   */
  async sendMessage(chatId: string, text: string): Promise<string | null> {
    try {
      // Convert markdown to Teams-compatible HTML if needed
      const body = this.formatMessageBody(text);

      const res = await this.axios.post(`/me/chats/${chatId}/messages`, {
        body: {
          contentType: 'html',
          content: body,
        },
      });

      const messageId = res.data?.id;
      console.log(`[Teams] ✅ Message sent to ${chatId}: ${messageId}`);
      return messageId || null;
    } catch (e: any) {
      console.error('[Teams] ❌ Failed to send message:', e.response?.data || e.message);
      return null;
    }
  }

  /**
   * Edit/update an existing message
   */
  async editMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    try {
      const body = this.formatMessageBody(text);

      await this.axios.patch(`/me/chats/${chatId}/messages/${messageId}`, {
        body: {
          contentType: 'html',
          content: body,
        },
      });

      console.log(`[Teams] ✅ Message edited: ${messageId}`);
      return true;
    } catch (e: any) {
      console.error('[Teams] ❌ Failed to edit message:', e.response?.data || e.message);
      return false;
    }
  }

  /**
   * Format message body - convert simple markdown to HTML
   */
  private formatMessageBody(text: string): string {
    // Basic markdown -> HTML conversion
    let html = text
      // Code blocks
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre>$2</pre>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Bold
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      // Line breaks
      .replace(/\n/g, '<br/>');

    return html;
  }

  /**
   * Start polling for new messages
   */
  async startPolling(onMessage: IncomingMessageHandler): Promise<void> {
    if (this.polling) {
      console.log('[Teams] Polling already started');
      return;
    }

    this.polling = true;
    console.log('[Teams] ✅ Starting message polling...');

    // Track last seen message time per chat
    const lastSeenMap = new Map<string, string>();

    // Initial fetch to get baseline
    const chats = await this.listChats();
    for (const chat of chats) {
      const messages = await this.getMessages(chat.id, 1);
      if (messages.length > 0) {
        lastSeenMap.set(chat.id, messages[0].createdDateTime);
      }
    }

    // Poll loop
    while (this.polling) {
      try {
        const chats = await this.listChats();

        for (const chat of chats) {
          const messages = await this.getMessages(chat.id, 5);
          const lastSeen = lastSeenMap.get(chat.id);

          for (const msg of messages.reverse()) {
            // Skip if already processed
            if (this.isMessageProcessed(msg.id)) continue;

            // Skip if older than last seen
            if (lastSeen && msg.createdDateTime <= lastSeen) continue;

            // Skip messages from the bot itself (from.user is null for bot messages)
            if (!msg.from?.user?.id) continue;

            // Extract text content
            const text = this.extractTextContent(msg);
            if (!text) continue;

            console.log(`[Teams] 📥 New message in ${chat.id}: ${text.slice(0, 50)}...`);

            await onMessage(
              chat.id,
              text,
              msg.id,
              msg.from.user.id,
              undefined // TODO: handle attachments
            );
          }

          // Update last seen
          if (messages.length > 0) {
            lastSeenMap.set(chat.id, messages[0].createdDateTime);
          }
        }
      } catch (e: any) {
        console.error('[Teams] ❌ Polling error:', e.message);
      }

      await sleep(this.pollInterval);
    }
  }

  /**
   * Extract text content from a Teams message
   */
  private extractTextContent(msg: any): string {
    if (!msg.body) return '';

    let content = msg.body.content || '';

    // If HTML, strip tags (basic)
    if (msg.body.contentType === 'html') {
      content = content
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"');
    }

    // Remove @mentions (they show as <at id="...">Name</at>)
    content = content.replace(/<at[^>]*>[^<]*<\/at>/gi, '').trim();

    return content;
  }

  /**
   * Stop polling
   */
  async stop(): Promise<void> {
    this.polling = false;
    console.log('[Teams] ✅ Polling stopped');
  }

  /**
   * Send a message to start a new 1:1 chat with a user
   */
  async sendDirectMessage(userId: string, text: string): Promise<{ chatId: string; messageId: string } | null> {
    try {
      // Create or get 1:1 chat
      const chatRes = await this.axios.post('/me/chats', {
        chatType: 'oneOnOne',
        members: [
          {
            '@odata.type': '#microsoft.graph.aadUserConversationMember',
            roles: ['owner'],
            'user@odata.bind': `https://graph.microsoft.com/v1.0/users/${userId}`,
          },
          {
            '@odata.type': '#microsoft.graph.aadUserConversationMember',
            roles: ['owner'],
            'user@odata.bind': 'https://graph.microsoft.com/v1.0/me',
          },
        ],
      });

      const chatId = chatRes.data?.id;
      if (!chatId) {
        console.error('[Teams] ❌ Failed to create/get chat');
        return null;
      }

      const messageId = await this.sendMessage(chatId, text);
      if (!messageId) return null;

      return { chatId, messageId };
    } catch (e: any) {
      console.error('[Teams] ❌ Failed to send DM:', e.response?.data || e.message);
      return null;
    }
  }
}
