# openminis-server

Self-hosted, always-on cloud runtime for OpenMinis agents. Milestone 1 of the
plan in the project thread: one machine runs your agents 24/7, keeps their
files and memory, and fires scheduled routines even when your phone is off.

## Run

```sh
cd server
npm install
export ANTHROPIC_API_KEY=sk-ant-...
export MINIS_API_TOKEN=$(openssl rand -hex 24)   # clients send this as a Bearer token
npm start                                         # listens on :8787
```

| Variable | Default | |
|---|---|---|
| `MINIS_MODEL` | `claude-sonnet-5-5` | Model for agent runs |
| `MINIS_SANDBOX` | `local` | `local` runs commands on the host in the role's workspace; `docker` runs each in a throwaway container |
| `MINIS_DOCKER_IMAGE` | `alpine:3.20` | Image for `docker` sandbox |
| `MINIS_DATA_DIR` | `./data` | Roles, sessions, routines, audit log |
| `MINIS_MAX_TURNS` | `40` | Tool-loop budget per run |
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

## Concepts

- **Role**: a coworker with its own `SOUL.md` (same format as the apps), private `MEMORY.md` and workspace. Created on first use, under `data/roles/<role>/`.
- **Session**: a conversation with a role, persisted as JSON.
- **Routine**: a cron schedule (with timezone) that sends a prompt to a role.
- **Channel**: a group chat of several roles. Unaddressed messages go to the first (lead) role, `@role` addresses one directly, and a role can call `handoff` to pass the work to another (up to 6 hops per message). Each role keeps its own memory and session; they share only what is posted.
- **Audit log**: every run and tool call, in `data/audit.jsonl`.

## API

All routes except `/health` need `Authorization: Bearer $MINIS_API_TOKEN`.

```sh
H="Authorization: Bearer $MINIS_API_TOKEN"
# talk to the "dev" role
curl -H "$H" -d '{"prompt":"Clone github.com/OpenMinis/OpenMinis and summarise open TODOs"}' localhost:8787/roles/dev/messages
# give it a persona
curl -H "$H" -X PUT --data-binary @SOUL.md localhost:8787/roles/dev/soul
# every weekday 9:00 Shanghai time
curl -H "$H" -d '{"roleId":"dev","cron":"0 9 * * 1-5","timezone":"Asia/Shanghai","prompt":"Check CI and report failures"}' localhost:8787/routines
# a team channel: lead answers first and hands off to dev or ops
curl -H "$H" -d '{"id":"team","roles":["lead","dev","ops"]}' localhost:8787/channels
curl -H "$H" -d '{"text":"The login page is slow, find out why and fix it"}' localhost:8787/channels/team/messages
curl -H "$H" localhost:8787/audit?limit=20
```

See `src/http.ts` for the full route list.

## Next milestones

Browser tool · M3 GitHub/CI/webhook/Slack triggers · M4 approval gateway, action recording, network controls.
