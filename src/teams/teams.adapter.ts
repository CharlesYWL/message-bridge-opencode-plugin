// src/teams/teams.adapter.ts
import type { BridgeAdapter, IncomingMessageHandler, TeamsConfig } from '../types';
import { TeamsClient } from './teamsClient';

export class TeamsAdapter implements BridgeAdapter {
  private client: TeamsClient;
  private config: TeamsConfig;

  constructor(config: TeamsConfig) {
    this.config = config;
    this.client = new TeamsClient(config);
  }

  async start(onMessage: IncomingMessageHandler): Promise<void> {
    await this.client.startPolling(onMessage);
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }

  async sendMessage(chatId: string, text: string): Promise<string | null> {
    return this.client.sendMessage(chatId, text);
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    return this.client.editMessage(chatId, messageId, text);
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    // Teams Graph API doesn't support reactions in the same way
    // Could be implemented via /me/chats/{chatId}/messages/{messageId}/reactions
    console.log(`[Teams] addReaction not fully implemented: ${messageId} ${emojiType}`);
    return null;
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    console.log(`[Teams] removeReaction not implemented: ${messageId} ${reactionId}`);
  }
}
