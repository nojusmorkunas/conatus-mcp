# Conatus MCP Server

An independently installable [Model Context Protocol](https://modelcontextprotocol.io/) server for the self-hosted Conatus task manager.

It exposes agent-safe tools for projects, sections, tasks, labels, comments and reminders. It supports local `stdio` clients and remote Streamable HTTP clients. Permanent deletion is intentionally not exposed.

## Requirements

- Node.js 20 or newer
- A reachable Conatus installation with the `/api/v1` API
- A scoped API token created in **Settings → API tokens**

## Local stdio setup

The local mode is the recommended default. The AI host starts one MCP process for the configured task-manager account.

### One-command setup

Run the interactive installer to validate your Conatus URL and scoped API token, then register the server with Claude Desktop, Claude Code, Cursor, or another JSON MCP configuration file:

```bash
npx -y conatus-mcp setup
```

Both menus are arrow-key pickers. Move with up and down, tick a client with space, press `a` to tick every client, then enter to confirm. Pressing enter without ticking anything takes the highlighted row, so installing into one client needs no space bar. Escape or ctrl-c quits before anything is written.

If earlier runs already left working tokens in those configs, the installer lists every Conatus installation it found, names the clients pointed at each one, and lets you pick which to install. The last option is always a fresh URL and token. Two clients sharing a token show up once, since a scoped token only works against the installation that issued it, so URL and token always travel together.

The installer never echoes the token, verifies it before changing any config file, and restricts every file it writes to owner-only permissions where the operating system supports them. Existing servers in those files are left alone. Restart the clients you chose when it finishes. The direct configuration below remains the non-interactive fallback.

```json
{
  "mcpServers": {
    "my-tasks": {
      "command": "npx",
      "args": ["-y", "conatus-mcp"],
      "env": {
        "TASKS_BASE_URL": "https://tasks.example.com",
        "TASKS_API_TOKEN": "tdm_replace_me"
      }
    }
  }
}
```

For a local development installation, use `http://localhost:3000` as `TASKS_BASE_URL`.

You can also install the package once:

```bash
npm install --global conatus-mcp
conatus-mcp
```

## Remote Streamable HTTP mode with browser OAuth

Use OAuth when an agent needs to connect by URL. The MCP server acts as a single-user gateway: its scoped `TASKS_API_TOKEN` identifies the task workspace, while each AI client receives a separate short-lived OAuth token. The task token never leaves the server.

```bash
TASKS_BASE_URL=https://tasks.example.com \
TASKS_API_TOKEN=tdm_replace_me \
MCP_HOST=0.0.0.0 \
MCP_PORT=3001 \
MCP_PUBLIC_URL=https://mcp.example.com/mcp \
MCP_OAUTH_PASSWORD='use-a-long-separate-approval-password' \
MCP_OAUTH_STORE_PATH=/var/lib/task-mcp/oauth-store.json \
MCP_ALLOWED_ORIGINS=https://your-ai-host.example \
conatus-mcp-http
```

Give the AI client only `https://mcp.example.com/mcp`. A compatible client discovers the protected-resource metadata, dynamically registers itself, opens the approval page and completes an OAuth authorization-code flow with S256 PKCE. Enter `MCP_OAUTH_PASSWORD` in that page to approve it.

The server issues one-hour access tokens and rotating 30-day refresh tokens. OAuth client registrations and token hashes are stored in the file at `MCP_OAUTH_STORE_PATH` with mode `0600`; raw OAuth tokens and the approval password are not stored. Run one MCP replica per store file. For multiple replicas, replace the JSON store with a shared transactional store first.

Put TLS and a reverse proxy in front of port 3001. `MCP_PUBLIC_URL` must be the exact external endpoint and end in `/mcp`. Production URLs must use HTTPS. Requests carrying an `Origin` header are accepted only when the origin is listed in `MCP_ALLOWED_ORIGINS`; native clients commonly send no Origin.

### Domain and reverse proxy

The task app and MCP gateway can use separate addresses:

- `https://tasks.example.com` → the web app and `/api/v1`
- `https://mcp.example.com/mcp` → this child MCP service

Create DNS records for both names, terminate TLS at your proxy and forward `mcp.example.com` to port 3001. Only the proxy should expose that port. The OAuth metadata, registration, authorization, token, revocation, approval and MCP endpoints all share the MCP origin.

### Static bearer fallback

For clients that cannot perform OAuth, omit `MCP_PUBLIC_URL` and `MCP_OAUTH_PASSWORD`, then set `MCP_BEARER_TOKEN` to a long random value. Connect to `/mcp` and send that value as a bearer token. This is less convenient to rotate per client and should not be pasted into prompts.

Binding to a non-loopback address without either complete OAuth configuration or `MCP_BEARER_TOKEN` is rejected.

### Docker

Released images are published to `ghcr.io/nojusmorkunas/conatus-mcp`. Build locally only when working on the server itself:

```bash
docker build -t conatus-mcp .
docker run --rm -p 127.0.0.1:3001:3001 \
  -v task-mcp-oauth:/data \
  -e TASKS_BASE_URL=https://tasks.example.com \
  -e TASKS_API_TOKEN=tdm_replace_me \
  -e MCP_HOST=0.0.0.0 \
  -e MCP_PUBLIC_URL=https://mcp.example.com/mcp \
  -e MCP_OAUTH_PASSWORD='use-a-long-separate-approval-password' \
  -e MCP_OAUTH_STORE_PATH=/data/oauth-store.json \
  conatus-mcp
```

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TASKS_BASE_URL` | yes | none | Task-manager origin without `/api/v1` |
| `TASKS_API_TOKEN` | yes | none | `tdm_` scoped token or a legacy `tdc_` token |
| `TASKS_REQUEST_TIMEOUT_MS` | no | `15000` | Upstream API timeout |
| `MCP_HOST` | HTTP only | `127.0.0.1` | HTTP bind address |
| `MCP_PORT` | HTTP only | `3001` | HTTP port |
| `MCP_ALLOWED_ORIGINS` | no | task-manager origin | Comma-separated browser origins |
| `MCP_PUBLIC_URL` | OAuth mode | none | Exact public HTTPS MCP URL ending in `/mcp` |
| `MCP_OAUTH_PASSWORD` | OAuth mode | none | Separate 16+ byte password entered on the approval page |
| `MCP_OAUTH_STORE_PATH` | no | `./data/oauth-store.json` | Persistent OAuth registrations and token hashes |
| `MCP_BEARER_TOKEN` | bearer mode | none | Static fallback credential clients use to access MCP |

Do not put tokens in prompts, tool arguments, source control or command-line arguments. Environment variables keep them out of MCP messages and most process listings.

To revoke one OAuth client, let that client call the advertised revocation endpoint. To revoke every connected client, stop the service and remove its OAuth store file, then restart; all clients must connect again. Revoke or rotate `TASKS_API_TOKEN` in task-manager Settings if the gateway itself is compromised.

## Tools

- Workspace: `get_workspace_context`
- Projects: `list_projects`, `get_project`, `create_project`, `update_project`
- Sections: `create_section`, `update_section`
- Tasks: `list_tasks`, `get_task`, `create_task`, `quick_add_task`, `update_task`, `move_task`, `complete_task`, `reopen_task`, `set_task_labels`
- Labels: `list_labels`, `create_label`
- Collaboration: `add_comment`
- Scheduling: `set_reminder`

Create operations use idempotency keys so retries do not create duplicate tasks. Task and comment content is returned as structured user data and must not be treated as agent instructions.

## Resources

- `taskapp://workspace`
- `taskapp://views/today`
- `taskapp://views/upcoming`
- `taskapp://projects/{id}`
- `taskapp://tasks/{id}`

## Development

```bash
npm install
npm test
npm run build
npm run dev
```

Test the built stdio server with MCP Inspector:

```bash
TASKS_BASE_URL=http://localhost:3000 \
TASKS_API_TOKEN=tdm_replace_me \
npx @modelcontextprotocol/inspector node dist/cli.js
```

## Releasing

Publishing a GitHub release builds `ghcr.io/nojusmorkunas/conatus-mcp` for `linux/amd64` and `linux/arm64`, then stages the npm package. Both come from the released commit.

Tag the release `vX.Y.Z` matching `package.json`; the npm job refuses to publish a mismatch. Mark prereleases as such on GitHub and they go to the `beta` dist-tag, leaving `latest` on the newest stable release.

The release event reads this workflow from the commit the tag points at, not from `main`. Changing the workflow only takes effect for releases tagged afterwards.

### Approving a staged release

npm publishing uses [trusted publishing](https://docs.npmjs.com/trusted-publishers), so this repository stores no npm token. The trusted publisher grants [staged publishing](https://docs.npmjs.com/staged-publishing/) only, which means the workflow uploads the tarball and stops. Nobody can install that version until a maintainer approves it.

Approve it in the Staged Packages tab on npmjs.com, or from a terminal:

```bash
npm stage list
npm stage approve <stage-id>
```

Both ask for 2FA. Inspect the tarball first with `npm stage download <stage-id>` if the release was not cut by hand.

The dist-tag is fixed when the version is staged and cannot be changed at approval. A release accidentally marked prerelease stages to `beta`, so reject it with `npm stage reject <stage-id>` and cut a new release rather than trying to retag it.

Direct publishing from CI is deliberately not granted. Anything able to trigger the workflow could otherwise push a version to npm with no human in the loop, and this package holds a scoped API token on the machines that install it.

To publish by hand instead:

```bash
npm publish --tag latest   # or --tag beta for a prerelease
```

Name the dist-tag explicitly. npm rejects a bare `npm publish` for any version with a semver prerelease suffix, which every `0.x.y-beta.z` has.

`prepublishOnly` reruns the test, lint and build checks. `publishConfig.access` is already set, so no `--access` flag is needed.
