// src/types.ts

export type BridgeMode = 'ws' | 'webhook';

import type { FilePartInput, TextPartInput } from '@opencode-ai/sdk';

export type IncomingMessageHandler = (
  chatId: string,
  text: string,
  messageId: string,
  senderId: string,
  parts?: Array<TextPartInput | FilePartInput>
) => Promise<void>;

export interface BridgeAdapter {
  start(onMessage: IncomingMessageHandler): Promise<void>;

  stop?(): Promise<void>;

  sendMessage(chatId: string, text: string): Promise<string | null>;

  editMessage(chatId: string, messageId: string, text: string): Promise<boolean>;

  addReaction?(messageId: string, emojiType: string): Promise<string | null>;

  removeReaction?(messageId: string, reactionId: string): Promise<void>;
}

export interface FeishuConfig {
  app_id: string;
  app_secret: string;
  mode: BridgeMode;
  callback_url?: string;
  encrypt_key?: string;
  tenant_token?: string;
  disable_token_cache?: boolean;
}

export interface TeamsConfig {
  /** Azure AD App Client ID */
  client_id: string;
  /** Client Secret (optional for public clients) */
  client_secret?: string;
  /** Tenant ID (use 'common' for multi-tenant) */
  tenant_id?: string;
  /** OAuth Access Token (delegated) */
  access_token?: string;
  /** OAuth Refresh Token for auto-renewal */
  refresh_token?: string;
  /** Polling interval in ms (default: 3000) */
  poll_interval_ms?: number;
  /** Target user ID for DM (optional - if set, will auto-create chat) */
  target_user_id?: string;
}
