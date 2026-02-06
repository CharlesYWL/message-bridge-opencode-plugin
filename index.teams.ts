// index.teams.ts - Teams-only bridge entry point
import type { Plugin } from '@opencode-ai/plugin';
import type { Config } from '@opencode-ai/sdk';

import { globalState } from './src/utils';
import { AGENT_TEAMS } from './src/constants';

import { AdapterMux } from './src/handler/mux';
import { startGlobalEventListener, createIncomingHandler } from './src/handler';

import { TeamsAdapter } from './src/teams/teams.adapter';
import type { TeamsConfig, BridgeAdapter } from './src/types';

function isEnabled(cfg: Config, key: string): boolean {
  const node = cfg?.agent?.[key];
  if (!node) return false;
  if (node.disable === true) return false;
  return true;
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

export const TeamsBridgePlugin: Plugin = async ctx => {
  const { client } = ctx;
  console.log('[Plugin] TeamsBridgePlugin initializing...');

  const bootstrap = async () => {
    try {
      const raw = await client.config.get();
      const cfg = (raw?.data || raw || {}) as Config;

      const mux: AdapterMux = globalState.__bridge_mux || new AdapterMux();
      globalState.__bridge_mux = mux;

      if (!isEnabled(cfg, AGENT_TEAMS)) {
        console.log('[Plugin] teams-bridge not enabled in config.');
        return;
      }

      const teamsCfg = parseTeamsConfig(cfg);
      const adapter = new TeamsAdapter(teamsCfg);

      mux.register(AGENT_TEAMS, adapter);
      const incoming = createIncomingHandler(client, mux, AGENT_TEAMS);
      await adapter.start(incoming);
      console.log(`[Plugin] ✅ Started Teams adapter`);

      if (!globalState.__bridge_listener_started) {
        globalState.__bridge_listener_started = true;
        startGlobalEventListener(client, mux).catch(err => {
          console.error('[Plugin] ❌ startGlobalEventListener failed:', err);
          globalState.__bridge_listener_started = false;
        });
      }

      console.log('[Plugin] ✅ TeamsBridgePlugin ready.');
    } catch (e) {
      console.error('[Plugin] Bootstrap error:', e);
    }
  };

  bootstrap();
  return {};
};
