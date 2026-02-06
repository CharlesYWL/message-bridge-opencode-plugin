# Microsoft Teams Bridge for OpenCode

This plugin enables OpenCode to send and receive messages via Microsoft Teams DM using Microsoft Graph API (delegated permissions).

## Architecture

```
OpenCode CLI
  └─ Plugin: teams-bridge
       └─ Microsoft Graph API (delegated)
            └─ Teams DM (as signed-in user)
```

**Key points:**
- Messages appear **as the signed-in user** (not a bot)
- No Azure Bot Service required
- Uses OAuth 2.0 device code or authorization code flow
- Polls for new messages (configurable interval)

## Prerequisites

### 1. Register an Azure AD App

1. Go to [Azure Portal](https://portal.azure.com) → Azure Active Directory → App registrations
2. Click "New registration"
3. Name: `OpenCode Teams Bridge` (or whatever you prefer)
4. Supported account types: Choose based on your needs
   - "Accounts in this organizational directory only" for single-tenant
   - "Accounts in any organizational directory" for multi-tenant
5. Redirect URI: Add `http://localhost:3847/callback` as "Mobile and desktop applications"
6. Click "Register"

### 2. Configure API Permissions

1. Go to your app → API permissions
2. Click "Add a permission" → Microsoft Graph → Delegated permissions
3. Add these permissions:
   - `Chat.ReadWrite` - Read and write user chat messages
   - `ChatMessage.Send` - Send chat messages
   - `offline_access` - Maintain access (for refresh token)
4. Click "Grant admin consent" (if you're an admin) or wait for admin approval

### 3. Get OAuth Tokens

Run the helper script:

```bash
cd message-bridge-opencode-plugin
node scripts/teams-oauth.js <client_id> [tenant_id]
```

This will:
1. Print an authorization URL
2. Start a local server on port 3847
3. Exchange the auth code for tokens

Example:
```bash
node scripts/teams-oauth.js 12345678-1234-1234-1234-123456789abc my-tenant.onmicrosoft.com
```

## Configuration

Add to your `opencode.json`:

```json
{
  "agent": {
    "teams-bridge": {
      "options": {
        "client_id": "your-azure-app-client-id",
        "tenant_id": "your-tenant-id-or-common",
        "access_token": "your-oauth-access-token",
        "refresh_token": "your-oauth-refresh-token",
        "poll_interval_ms": 3000
      }
    }
  }
}
```

### Options

| Option | Required | Description |
|--------|----------|-------------|
| `client_id` | Yes | Azure AD App Client ID |
| `tenant_id` | No | Tenant ID (default: `common`) |
| `access_token` | Yes* | OAuth access token |
| `refresh_token` | Yes* | OAuth refresh token (for auto-renewal) |
| `client_secret` | No | Client secret (only for confidential clients) |
| `poll_interval_ms` | No | Polling interval in ms (default: 3000) |
| `target_user_id` | No | Auto-create DM with this user ID |

*Either `access_token` or `refresh_token` is required. With `refresh_token`, the plugin will auto-renew expired tokens.

## Usage

Once configured, OpenCode will:

1. Poll your Teams chats for new messages
2. Process incoming messages through OpenCode
3. Send responses back to the same chat

### Starting a Conversation

You can either:
1. Send a message to yourself in Teams (the plugin monitors all your chats)
2. Use the `target_user_id` option to auto-create a DM with a specific user

## Security Notes

- **Delegated permissions**: The plugin acts as you, not as a bot
- **Token storage**: Tokens are stored in your `opencode.json` - keep it secure
- **Refresh tokens**: Are long-lived but can be revoked from Azure AD
- **Scope**: Only requests Chat.ReadWrite and ChatMessage.Send permissions

## Troubleshooting

### "Missing options for teams-bridge"
Ensure `client_id` and either `access_token` or `refresh_token` are set in config.

### "Failed to refresh token"
Your refresh token may have expired. Re-run the OAuth flow:
```bash
node scripts/teams-oauth.js <client_id>
```

### "403 Forbidden"
Check that:
1. API permissions are granted
2. Admin consent is given (if required by your tenant)
3. The user has a Teams license

### Messages not appearing
- Increase `poll_interval_ms` if you're hitting rate limits
- Check that the signed-in user has access to the chat

## Limitations

- **Polling-based**: Not real-time like WebSocket (Teams doesn't offer Graph subscriptions for chat messages in all scenarios)
- **User identity**: Messages appear as you, not a bot
- **Rate limits**: Microsoft Graph has rate limits; don't set poll interval too low

## Related

- [Microsoft Graph Chat API](https://learn.microsoft.com/en-us/graph/api/resources/chat)
- [OAuth 2.0 Authorization Code Flow](https://learn.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-auth-code-flow)
