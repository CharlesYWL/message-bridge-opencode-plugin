#!/usr/bin/env node
// scripts/teams-oauth.js
// Helper script to obtain OAuth tokens for Microsoft Graph API
// Usage: node scripts/teams-oauth.js <client_id> [tenant_id]

const http = require('http');
const https = require('https');
const { URL } = require('url');

const CLIENT_ID = process.argv[2];
const TENANT_ID = process.argv[3] || 'common';

if (!CLIENT_ID) {
  console.error('Usage: node teams-oauth.js <client_id> [tenant_id]');
  console.error('');
  console.error('Prerequisites:');
  console.error('1. Register an app in Azure AD (portal.azure.com)');
  console.error('2. Add redirect URI: http://localhost:3847/callback');
  console.error('3. Enable "Mobile and desktop applications" platform');
  console.error('4. Grant API permissions: Chat.ReadWrite, ChatMessage.Send, offline_access');
  process.exit(1);
}

const REDIRECT_URI = 'http://localhost:3847/callback';
const SCOPES = 'Chat.ReadWrite ChatMessage.Send offline_access';

const AUTH_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;

function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    response_mode: 'query',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
    });

    const url = new URL(TOKEN_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(params.toString()),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(`${json.error}: ${json.error_description}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(params.toString());
    req.end();
  });
}

async function main() {
  console.log('=== Microsoft Teams OAuth Helper ===\n');
  console.log(`Client ID: ${CLIENT_ID}`);
  console.log(`Tenant ID: ${TENANT_ID}`);
  console.log('');

  const authUrl = buildAuthUrl();
  console.log('1. Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\n2. Sign in and grant permissions');
  console.log('3. You will be redirected to localhost:3847/callback');
  console.log('\nStarting local server to receive callback...\n');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Error</h1><p>${error}: ${url.searchParams.get('error_description')}</p>`);
        console.error(`Error: ${error}`);
        process.exit(1);
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Success!</h1><p>You can close this window. Check the terminal for tokens.</p>');

        try {
          console.log('Exchanging code for tokens...\n');
          const tokens = await exchangeCodeForTokens(code);

          console.log('=== SUCCESS ===\n');
          console.log('Add these to your opencode.json config:\n');
          console.log(JSON.stringify({
            agent: {
              'teams-bridge': {
                options: {
                  client_id: CLIENT_ID,
                  tenant_id: TENANT_ID,
                  access_token: tokens.access_token,
                  refresh_token: tokens.refresh_token,
                  poll_interval_ms: 3000,
                },
              },
            },
          }, null, 2));

          console.log('\n=== Token Details ===');
          console.log(`Access Token (expires in ${tokens.expires_in}s):`);
          console.log(tokens.access_token.substring(0, 50) + '...');
          console.log(`\nRefresh Token:`);
          console.log(tokens.refresh_token.substring(0, 50) + '...');

          setTimeout(() => process.exit(0), 1000);
        } catch (e) {
          console.error('Failed to exchange code:', e.message);
          process.exit(1);
        }
      }
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(3847, () => {
    console.log('Listening on http://localhost:3847');
    console.log('Waiting for OAuth callback...\n');
  });
}

main().catch(console.error);
