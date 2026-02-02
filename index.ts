import type { Plugin } from '@opencode-ai/plugin';
import type { Config } from '@opencode-ai/sdk';
import { FeishuClient } from './src/feishu';
import { buildOpenCodeApi } from './src/opencode';
import { createMessageHandler, startGlobalEventListener } from './src/handler';
import type { FeishuConfig } from './src/types';
import { PLUGIN_CONFIG_NAME } from './src/constants';
import { globalState } from './src/utils';

if (!globalState.__feishu_plugin_listener_started) {
  globalState.__feishu_plugin_listener_started = false;
}

let feishuInstance: FeishuClient | null = globalState.__feishu_client_instance || null;

export const FeishuBridgePlugin: Plugin = async ctx => {
  const { client } = ctx;
  console.log('[Plugin] Plugin Initializing...');

  const bootstrap = async () => {
    try {
      const configPromise = client.config.get();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Config Timeout')), 1000)
      );

      let rawResponse: any = null;
      try {
        rawResponse = await Promise.race([configPromise, timeoutPromise]);
      } catch (e) {
        console.error('[Plugin] Config API Failed', e);
        return;
      }

      const agentConfig = (rawResponse?.data || rawResponse || {}) as Config;
      const larkConfig = (agentConfig?.agent?.[PLUGIN_CONFIG_NAME]?.options || {}) as Record<
        string,
        any
      >;

      const appId = larkConfig.app_id;
      const appSecret = larkConfig.app_secret;
      const mode = (larkConfig.mode || 'ws').toLowerCase();

      if (!appId || !appSecret) {
        console.error('[Plugin] ❌ Missing app_id or app_secret');
        return;
      }

      const config: FeishuConfig = {
        appId,
        appSecret,
        port: larkConfig.port ? parseInt(larkConfig.port, 10) : undefined,
        path: larkConfig.path,
        encryptKey: larkConfig.encrypt_key,
        mode: mode as 'ws' | 'webhook',
      };

      const api = buildOpenCodeApi(client);

      if (!feishuInstance) {
        console.log('[Plugin] Creating new FeishuClient...');
        feishuInstance = new FeishuClient(config);
        globalState.__feishu_client_instance = feishuInstance;
      } else {
        console.log('[Plugin] Reusing existing FeishuClient instance.');
      }

      const feishuClient = feishuInstance!;

      if (!globalState.__feishu_plugin_listener_started) {
        console.log('[Plugin] Starting Global Event Listener...');

        startGlobalEventListener(api, feishuClient).catch(err => {
          console.error('[Plugin] ❌ Failed to start Global Event Listener:', err);
          globalState.__feishu_plugin_listener_started = false;
        });

        globalState.__feishu_plugin_listener_started = true;
      } else {
        console.log('[Plugin] Global Event Listener already running. Skipping.');
      }

      const messageHandler = createMessageHandler(api, feishuClient);

      if (config.mode === 'webhook') {
        await feishuClient.startWebhook(messageHandler);
      } else {
        await feishuClient.startWebSocket(messageHandler);
      }

      console.log(`[Plugin] 🚀 Service Ready in [${mode}] mode.`);
    } catch (error) {
      console.error('[Plugin] Bootstrap Error:', error);
    }
  };

  bootstrap();

  return {};
};
