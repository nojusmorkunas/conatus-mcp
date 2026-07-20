# Conatus MCP Server

Connect AI assistants to a self-hosted [Conatus](https://github.com/nojusmorkunas/conatus) task manager through the [Model Context Protocol](https://modelcontextprotocol.io/).

The server exposes focused tools for projects, sections, tasks, labels, comments, and reminders. It talks to Conatus through its versioned HTTP API, never accesses the database directly, and intentionally provides no permanent-delete tool.

## How it fits together

```text
Codex, ChatGPT, Claude, or another MCP client
                    │
              MCP (stdio or HTTP)
                    │
             Conatus MCP server
                    │
          Conatus /api/v1 + API token
                    │
             Your Conatus instance
```

Every installation points the MCP server at the user's own Conatus address. That address can be local (`http://localhost:3000`), on a private network (`http://192.168.1.50:3000`), or hosted (`https://tasks.example.com`).

## Requirements

- Node.js 20 or newer
- A reachable Conatus installation with the `/api/v1` API
- A scoped token created in **Conatus → Settings → API tokens**

## Quick start: local MCP process

Local stdio mode is the recommended setup. The AI client starts the MCP process when needed; Conatus itself may be running locally or remotely.

The npm package has not been released yet. Until the first release, build this repository locally:

```bash
git clone https://github.com/nojusmorkunas/conatus-mcp.git
cd conatus-mcp
npm ci
npm run build
```

Then register it with Codex, replacing the URL and token:

```bash
codex mcp add conatus \
  --env TASKS_BASE_URL=https://tasks.example.com \
  --env TASKS_API_TOKEN=tdm_replace_me \
  -- node /absolute/path/to/conatus-mcp/dist/stdio.js
```

Restart Codex and verify the connection:

```bash
codex mcp list
```

After the package is published to npm, the command becomes:

```bash
codex mcp add conatus \
  --env TASKS_BASE_URL=https://tasks.example.com \
  --env TASKS_API_TOKEN=tdm_replace_me \
  -- npx -y @conatus/mcp-server
```

For clients that use JSON configuration:

```json
{
  "mcpServers": {
    "conatus": {
      "command": "npx",
      "args": ["-y", "@conatus/mcp-server"],
      "env": {
        "TASKS_BASE_URL": "https://tasks.example.com",
        "TASKS_API_TOKEN": "tdm_replace_me"
      }
    }
  }
}
```

Do not append `/api/v1` to `TASKS_BASE_URL`; the MCP server adds the API path itself.

## Hosted MCP endpoint

Use Streamable HTTP mode when clients need to connect to a shared URL such as `https://mcp.example.com/mcp`. The gateway keeps the Conatus API token server-side and gives each AI client a separate OAuth session.

```bash
TASKS_BASE_URL=https://tasks.example.com \
TASKS_API_TOKEN=tdm_replace_me \
MCP_HOST=0.0.0.0 \
MCP_PORT=3001 \
MCP_PUBLIC_URL=https://mcp.example.com/mcp \
MCP_OAUTH_PASSWORD='use-a-long-separate-approval-password' \
MCP_OAUTH_STORE_PATH=./data/oauth-store.json \
MCP_ALLOWED_ORIGINS=https://your-ai-host.example \
npm run start:http
```

Give clients only `https://mcp.example.com/mcp`. Compatible clients discover the OAuth endpoints, dynamically register, open the browser approval page, and complete an authorization-code flow with S256 PKCE. Enter `MCP_OAUTH_PASSWORD` on the approval page.

Production deployments must put TLS and a reverse proxy in front of port 3001. `MCP_PUBLIC_URL` must be the exact public HTTPS endpoint ending in `/mcp`. Only the reverse proxy should expose the MCP port.

### Docker

```bash
docker build -t conatus-mcp .
docker run --rm -p 127.0.0.1:3001:3001 \
  -v conatus-mcp-oauth:/data \
  -e TASKS_BASE_URL=https://tasks.example.com \
  -e TASKS_API_TOKEN=tdm_replace_me \
  -e MCP_HOST=0.0.0.0 \
  -e MCP_PUBLIC_URL=https://mcp.example.com/mcp \
  -e MCP_OAUTH_PASSWORD='use-a-long-separate-approval-password' \
  -e MCP_OAUTH_STORE_PATH=/data/oauth-store.json \
  conatus-mcp
```

### Static bearer fallback

If a client cannot use OAuth, omit `MCP_PUBLIC_URL` and `MCP_OAUTH_PASSWORD`, then configure a long random `MCP_BEARER_TOKEN`. Send that value as a bearer token when connecting to `/mcp`.

Binding to a non-loopback address without complete OAuth configuration or `MCP_BEARER_TOKEN` is rejected.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TASKS_BASE_URL` | Always | — | Conatus origin, without `/api/v1` |
| `TASKS_API_TOKEN` | Always | — | Scoped `tdm_` token, or legacy `tdc_` token |
| `TASKS_REQUEST_TIMEOUT_MS` | No | `15000` | Upstream API timeout |
| `MCP_HOST` | HTTP only | `127.0.0.1` | HTTP bind address |
| `MCP_PORT` | HTTP only | `3001` | HTTP port |
| `MCP_ALLOWED_ORIGINS` | No | Conatus origin | Comma-separated browser origins |
| `MCP_PUBLIC_URL` | OAuth mode | — | Exact public HTTPS MCP URL ending in `/mcp` |
| `MCP_OAUTH_PASSWORD` | OAuth mode | — | Separate approval password of at least 16 bytes |
| `MCP_OAUTH_STORE_PATH` | No | `./data/oauth-store.json` | Persistent OAuth registrations and token hashes |
| `MCP_BEARER_TOKEN` | Bearer mode | — | Static credential used by HTTP clients |

## Available tools

- Workspace: `get_workspace_context`
- Projects: `list_projects`, `get_project`, `create_project`, `update_project`
- Sections: `create_section`, `update_section`
- Tasks: `list_tasks`, `get_task`, `create_task`, `quick_add_task`, `update_task`, `move_task`, `complete_task`, `reopen_task`, `set_task_labels`
- Labels: `list_labels`, `create_label`
- Collaboration: `add_comment`
- Scheduling: `set_reminder`

Create operations use idempotency keys so retries do not create duplicates. Tool responses return task and comment content as structured user data, not agent instructions.

## Available resources

- `taskapp://workspace`
- `taskapp://views/today`
- `taskapp://views/upcoming`
- `taskapp://projects/{id}`
- `taskapp://tasks/{id}`

## Security

- Treat `TASKS_API_TOKEN`, `MCP_OAUTH_PASSWORD`, and `MCP_BEARER_TOKEN` as secrets.
- Never commit secrets, paste them into prompts, or include them in tool arguments.
- Grant the Conatus API token only the scopes the client needs.
- Use HTTPS for every non-local Conatus or MCP endpoint.
- Revoke or rotate the Conatus API token if the gateway is compromised.
- To revoke every OAuth client, stop the gateway, remove its OAuth store, and restart it.

OAuth access tokens last one hour and rotating refresh tokens last 30 days. Registrations and token hashes are stored with mode `0600`; raw OAuth tokens and the approval password are not stored. Run one MCP replica per JSON store file.

## Development

```bash
npm ci
npm test
npm run lint
npm run build
npm pack --dry-run
```

Run the stdio server during development:

```bash
TASKS_BASE_URL=http://localhost:3000 \
TASKS_API_TOKEN=tdm_replace_me \
npm run dev
```

Test the built server with MCP Inspector:

```bash
TASKS_BASE_URL=http://localhost:3000 \
TASKS_API_TOKEN=tdm_replace_me \
npx @modelcontextprotocol/inspector node dist/stdio.js
```

## Publishing

The package is self-contained and can be published from this repository after the `@conatus` npm scope and package name are available:

```bash
npm publish --access public
```

Publishing automatically runs the test, lint, and build checks through `prepublishOnly`.

## License

[GNU Affero General Public License v3.0](LICENSE)
