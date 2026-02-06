// index.ts
import type { Plugin } from '@opencode-ai/plugin';
import type { Config } from '@opencode-ai/sdk';

import { globalState } from './src/utils';
import { AGENT_LARK, AGENT_IMESSAGE, AGENT_TELEGRAM, AGENT_TEAMS } from './src/constants';

import { AdapterMux } from './src/handler/mux';
import { startGlobalEventListener, createIncomingHandler } from './src/handler';

import { FeishuAdapter } from './src/feishu/feishu.adapter';
import { TeamsAdapter } from './src/teams/teams.adapter';
import type { FeishuConfig, TeamsConfig, BridgeAdapter } from './src/types';

// isEnabled
function isEnabled(cfg: Config, key: string): boolean {
  const node = cfg?.agent?.[key];
  if (!node) return false;
  if (node.disable === true) return false;
  return true;
}

function parseFeishuConfig(cfg: Config): FeishuConfig {
  const node = cfg?.agent?.[AGENT_LARK];
  const options = (node?.options || {}) as Record<string, any>;

  const app_id = options.app_id;
  const app_secret = options.app_secret;
  const mode = (options.mode || 'ws') as 'ws' | 'webhook';
  const callbackUrlRaw = options.callback_url;
  const callbackUrl =
    typeof callbackUrlRaw === 'string' && callbackUrlRaw.length > 0
      ? callbackUrlRaw.startsWith('http')
        ? callbackUrlRaw
        : `http://${callbackUrlRaw}`
      : undefined;

  if (mode === 'webhook' && !callbackUrl) {
    console.error(`[Plugin] Missing callback_url for ${AGENT_LARK} in webhook mode`);
  }

  if (!app_id || !app_secret) {
    throw new Error(`[Plugin] Missing options for ${AGENT_LARK}: app_id/app_secret`);
  }

  return {
    app_id,
    app_secret,
    mode,
    callback_url: callbackUrl,
    encrypt_key: options.encrypt_key,
    tenant_token: options.tenant_token,
    disable_token_cache: options.disable_token_cache,
  };
}

function parseTeamsConfig(cfg: Config): TeamsConfig {
  const node = cfg?.agent?.[AGENT_TEAMS];
  const options = (node?.options || {}) as Record<string, any>;

  const client_id = options.client_id;
  const client_secret = options.client_secret;
  const tenant_id = options.tenant_id || 'common';
  const access_token = options.access_token;
  const refresh_token = options.refresh_token;
  const poll_interval_ms = options.poll_interval_ms || 3000;
  const target_user_id = options.target_user_id;

  if (!client_id) {
    throw new Error(`[Plugin] Missing options for ${AGENT_TEAMS}: client_id`);
  }

  if (!access_token && !refresh_token) {
    throw new Error(`[Plugin] Missing options for ${AGENT_TEAMS}: access_token or refresh_token required`);
  }

  return {
    client_id,
    client_secret,
    tenant_id,
    access_token,
    refresh_token,
    poll_interval_ms,
    target_user_id,
  };
}

export const BridgePlugin: Plugin = async ctx => {
  const { client } = ctx;
  console.log('[Plugin] BridgePlugin entry initializing...');

  const bootstrap = async () => {
    try {
      const raw = await client.config.get();
      const cfg = (raw?.data || raw || {}) as Config;

      // mux 单例
      const mux: AdapterMux = globalState.__bridge_mux || new AdapterMux();
      globalState.__bridge_mux = mux;

      // 允许多个 adapter 同时启用
      const adaptersToStart: Array<{ key: string; adapter: BridgeAdapter }> = [];

      if (isEnabled(cfg, AGENT_LARK)) {
        const feishuCfg = parseFeishuConfig(cfg);
        adaptersToStart.push({ key: AGENT_LARK, adapter: new FeishuAdapter(feishuCfg) });
      }

      if (isEnabled(cfg, AGENT_IMESSAGE)) {
        console.log('[Plugin] imessage-bridge enabled (not implemented yet).');
        // TODO: mux.register(AGENT_IMESSAGE, new IMessageAdapter(...))
      }

      if (isEnabled(cfg, AGENT_TELEGRAM)) {
        console.log('[Plugin] telegram-bridge enabled (not implemented yet).');
        // TODO: mux.register(AGENT_TELEGRAM, new TelegramAdapter(...))
      }

      if (isEnabled(cfg, AGENT_TEAMS)) {
        const teamsCfg = parseTeamsConfig(cfg);
        adaptersToStart.push({ key: AGENT_TEAMS, adapter: new TeamsAdapter(teamsCfg) });
      }

      if (adaptersToStart.length === 0) {
        console.log('[Plugin] No bridge enabled.');
        return;
      }

      // 注册 + start（incoming）
      for (const { key, adapter } of adaptersToStart) {
        mux.register(key, adapter);
        const incoming = createIncomingHandler(client, mux, key);
        await adapter.start(incoming);
        console.log(`[Plugin] ✅ Started adapter: ${key}`);
      }

      // 全局 listener 只启动一次（mux）
      if (!globalState.__bridge_listener_started) {
        globalState.__bridge_listener_started = true;
        startGlobalEventListener(client, mux).catch(err => {
          console.error('[Plugin] ❌ startGlobalEventListener failed:', err);
          globalState.__bridge_listener_started = false;
        });
      } else {
        console.log('[Plugin] Global listener already started.');
      }

      console.log('[Plugin] ✅ BridgePlugin ready.');
    } catch (e) {
      console.error('[Plugin] Bootstrap error:', e);
    }
  };

  bootstrap();
  return {};
};
