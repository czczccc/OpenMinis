# openminis-server

Self-hosted, always-on runtime for OpenMinis agents. One machine runs your
digital coworkers around the clock: each role has its own persona, memory,
workspace, browser and permissions; they work in the background, react to
schedules, webhooks, GitHub events and Telegram messages, hand work to each
other in channels, and stop to ask you before doing anything risky.

## Run

```sh
cd server
npm install
(cd web && npm install && npm run build)        # web console, served at /
export ANTHROPIC_API_KEY=sk-ant-...
export MINIS_API_TOKEN=$(openssl rand -hex 24)   # clients send this as a Bearer token
npm start                                         # listens on :8787
```

| Variable | Default | |
|---|---|---|
| `MINIS_MODEL` | `claude-sonnet-5-5` | Model for agent runs |
| `MINIS_SANDBOX` | `local` | `local` runs commands on the host in the role's workspace; `docker` runs each in a throwaway container |
| `MINIS_DOCKER_IMAGE` | `alpine:3.20` | Image for the `docker` sandbox |
| `MINIS_DATA_DIR` | `./data` | Everything the server stores |
| `MINIS_MAX_TURNS` | `40` | Model calls per run |
| `MINIS_COMPACT_AT_TOKENS` | `120000` | Summarise older messages once a session is this large |
| `MINIS_APPROVAL_TIMEOUT_MINUTES` | `1440` | Unanswered approvals expire (= denied) after this |
| `MINIS_BROWSER` | on | `off` removes the browser tool |
| `MINIS_CHROMIUM_PATH` | Playwright's | Chromium binary, if not installed through Playwright |
| `MINIS_RECORD_BROWSER` | on | `off` stops saving a screenshot per browser action |
| `MINIS_PUBLIC_URL` | | Base URL shown in webhook addresses, e.g. `https://minis.example.com` |
| `PORT` | `8787` | |

Use `MINIS_SANDBOX=docker` on any machine you care about: `local` gives the agent a real shell as the server's user.

## Deploy on Ubuntu (22.04 / 24.04)

```sh
# Node 22 (Ubuntu's apt version is too old) and Docker
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs docker.io git
sudo useradd -m -s /bin/bash minis && sudo usermod -aG docker minis

sudo git clone https://github.com/czczccc/OpenMinis /opt/openminis
sudo chown -R minis:minis /opt/openminis
cd /opt/openminis/server && sudo -u minis npm install --omit=dev
sudo -u minis sh -c 'cd web && npm install && npm run build'

# Chromium for the browser tool (same Playwright version as package.json)
sudo npx -y playwright@1.64.1 install-deps chromium
sudo -u minis npx -y playwright@1.64.1 install chromium

sudo tee /etc/openminis.env >/dev/null <<ENV
ANTHROPIC_API_KEY=sk-ant-...
MINIS_API_TOKEN=$(openssl rand -hex 24)
MINIS_SANDBOX=docker
MINIS_DATA_DIR=/opt/openminis/server/data
ENV
sudo chmod 600 /etc/openminis.env
sudo grep MINIS_API_TOKEN /etc/openminis.env   # your API token

sudo cp deploy/openminis.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now openminis
journalctl -u openminis -f
```

The server speaks plain HTTP. Put it behind Caddy or nginx with HTTPS, or keep
the port firewalled and reach it over Tailscale/SSH, before exposing it.
Webhooks (`/hooks/...`) are the only routes that need to be reachable from outside.

## Web console

Open `http://<server>:8787/` and log in with `MINIS_API_TOKEN`. It is built
with [CZ Design System](https://github.com/czczccc/cz-design-system) (React +
Tailwind) in `web/`, works on phones, and updates live over `/events`:

- **频道 Channels**: group chats with your roles, handoffs shown inline
- **角色 Roles**: chat with a role (tool calls are expandable), edit its persona, read its memory, edit its policy
- **审批 Approvals**: approve or deny pending actions; history
- **任务 Tasks**: everything running or finished, with stop
- **自动化 Automation**: routines and webhook / GitHub triggers (copy URL and secret)
- **设置 Settings**: connectors, notifiers, token usage, audit log

After pulling changes, rebuild it with `cd web && npm run build`.
`cd web && npm run dev` serves it with hot reload against a server on :8787.

## Concepts

- **Role**: a coworker with its own `SOUL.md` (same format as the apps), private `MEMORY.md`, workspace, browser profile and `policy.json`. Created on first use under `data/roles/<role>/`.
- **Task**: every piece of work (API message, routine, webhook, Telegram message, channel post) runs as a background task. It can be listed, followed live, cancelled, and is resumed after a restart.
- **Channel**: a group chat of several roles. Unaddressed messages go to the first (lead) role, `@role` addresses one directly, and a role can call `handoff` to pass the work on (up to 6 hops per message). Roles share only what is posted.
- **Routine**: a cron schedule with timezone that sends a prompt to a role.
- **Trigger**: an inbound webhook (generic or GitHub) that starts a role or channel with a prompt built from the payload.
- **Connector**: an MCP server (email, calendar, GitHub, databases...) whose tools the roles can use.
- **Notifier**: Telegram, Slack or webhook destination for results and approval requests. Telegram is two-way.
- **Approval**: a risky tool call paused until a person approves it.

## Tools the agents have

| Tool | |
|---|---|
| `bash` | Shell in the role's workspace (host or Docker) |
| `read_file`, `write_file` | Files in the workspace |
| `remember` | Append to the role's long-term memory |
| `browser` | The role's own headless Chromium: navigate, snapshot (text + numbered elements), click, type, press, select, scroll, back, screenshot, tabs. Logins persist; each state-changing step is saved as a screenshot under `recordings/` |
| `<connector>__<tool>` | Every tool of every connected MCP server the role may use |
| `handoff` | In channels only: pass the work to another role |

## Permissions and approvals

`GET/PUT /roles/<role>/policy`:

```json
{
  "tools": { "bash": "allow", "write_file": "ask", "github__*": "ask", "mail__send_email": "deny" },
  "connectors": ["github", "mail"],
  "network": "all",
  "browserHosts": ["github.com", "google.com"],
  "askBash": ["\\bgit\\s+push\\b"]
}
```

- `tools`: `allow`, `ask` (needs approval) or `deny` (hidden from the role); `name*` prefixes work.
- Without a rule: connector tools marked read-only run freely, all other connector tools **ask**; bash commands matching `askBash` **ask** (default list covers `git push`, POST/PUT with curl or wget, ssh/scp/rsync, package publishing, mail, `rm -rf /`, docker/kubectl/terraform, `gh pr/issue create/merge/...`); everything else is allowed.
- `connectors`: which MCP servers the role sees (`"all"` by default).
- `network`: `none` runs the role's commands with no network (Docker sandbox only).
- `browserHosts`: the browser blocks every request to other hosts (suffix match; empty = any).

Pending approvals: `GET /approvals?status=pending`, answer with `POST /approvals/<id> {"approve": true}`, or tap Approve / Deny in Telegram. Declined or expired actions are reported to the agent, which is told not to retry. Every decision is in the audit log.

## Connectors (MCP)

`PUT /connectors` with the full list; the server reconnects and `GET /connectors` shows each one's status and tools.

```json
[
  { "id": "github", "type": "http", "url": "https://api.githubcopilot.com/mcp/",
    "headers": { "Authorization": "Bearer ghp_..." } },
  { "id": "files", "type": "stdio", "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/shared"],
    "readOnlyTools": ["read_file", "list_directory"] }
]
```

Stdio connectors get only their own `env` (plus `PATH`/`HOME`), never the server's secrets. Use `disabledTools` to hide tools and `readOnlyTools` to mark tools safe when the server does not say so itself.

## Triggers

```sh
# GitHub: start "dev" when CI fails or an issue is opened
curl -H "$H" -d '{"kind":"github","roleId":"dev","events":["workflow_run.failure","issues.opened"],
  "prompt":"GitHub event {{event}} on {{repository.full_name}}. Investigate and propose a fix.\n\n{{payload}}",
  "notify":["tg"]}' localhost:8787/triggers
```

The response has `url` and `secret`: in the repository go to Settings → Webhooks, set the payload URL to `url`, content type `application/json`, the secret to `secret`, and choose the events. Filters: `"event"`, `"event.action"`, or for `workflow_run` / `check_run` / `check_suite` `"event.<conclusion>"`.

Generic webhooks (`"kind":"webhook"`) accept `X-Minis-Secret: <secret>` or an `X-Hub-Signature-256` HMAC. Prompt templates support `{{event}}`, `{{payload}}` and `{{path.into.payload}}`.

## Notifiers

`PUT /notifiers`:

```json
[
  { "id": "tg", "kind": "telegram", "botToken": "123:ABC", "chatId": "987654321",
    "approvals": true, "inbound": { "channelId": "team" } },
  { "id": "slack", "kind": "slack", "webhookUrl": "https://hooks.slack.com/services/..." },
  { "id": "ops-hook", "kind": "webhook", "url": "https://example.com/minis" }
]
```

- Pass `"notify": ["tg"]` on messages, routines and triggers to get results there.
- `approvals: true` sends every approval request there (Telegram with Approve / Deny buttons).
- Telegram `inbound`: messages in that chat (and only that chat) go to the role or channel, and the reply comes back to the chat. Create the bot with @BotFather; get the chat id from `https://api.telegram.org/bot<token>/getUpdates` after messaging it.

## Background work and live events

```sh
H="Authorization: Bearer $MINIS_API_TOKEN"
curl -H "$H" -d '{"prompt":"Research our competitors' pricing","wait":false}' localhost:8787/roles/analyst/messages   # → task id
curl -H "$H" localhost:8787/tasks?status=running
curl -H "$H" -X POST localhost:8787/tasks/<id>/cancel
curl -N "localhost:8787/events?token=$MINIS_API_TOKEN"   # SSE: task_started, text, tool_call, tool_result, approval_requested, channel_message, task_finished...
```

Without `"wait": false`, message endpoints wait for the task and return it.

## Reliability

- Sessions are saved after every model call and tool call. Tasks that were running when the server stopped are resumed on start (channel posts are marked `interrupted` instead, since the transcript shows where they stopped).
- Long sessions are compacted: older messages are replaced by a model-written summary and archived under `sessions/archive/`.
- Model calls retry up to 5 times on rate limits and server errors.
- `GET /usage` shows requests and tokens per day and role.

## More examples

```sh
# give a role a persona
curl -H "$H" -X PUT --data-binary @SOUL.md localhost:8787/roles/dev/soul
# every weekday 9:00 Shanghai time, result to Telegram
curl -H "$H" -d '{"roleId":"dev","cron":"0 9 * * 1-5","timezone":"Asia/Shanghai","prompt":"Check CI and report failures","notify":["tg"]}' localhost:8787/routines
# a team channel: lead answers first and hands off to dev or ops
curl -H "$H" -d '{"id":"team","roles":["lead","dev","ops"]}' localhost:8787/channels
curl -H "$H" -d '{"text":"The login page is slow, find out why and fix it"}' localhost:8787/channels/team/messages
curl -H "$H" localhost:8787/audit?limit=20
```

The full route list is at the top of `src/http.ts`.

## Limits worth knowing

- The browser runs on the host inside Chromium's own sandbox (run the server as a normal user, as the systemd unit does), not inside the Docker sandbox.
- Network control for commands is all-or-nothing (`network: none`, Docker only); host allowlists apply to the browser.
- Pending approvals do not survive a restart; the resumed task asks again.
- Slack is outbound only; Telegram is the two-way chat channel.

## Development

```sh
npm run typecheck
npm test        # fake model API, real Chromium (set MINIS_CHROMIUM_PATH if needed), real MCP server
```
