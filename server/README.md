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

## Concepts

- **Role**: a coworker with its own `SOUL.md` (same format as the apps), private `MEMORY.md` and workspace. Created on first use, under `data/roles/<role>/`.
- **Session**: a conversation with a role, persisted as JSON.
- **Routine**: a cron schedule (with timezone) that sends a prompt to a role.
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
curl -H "$H" localhost:8787/audit?limit=20
```

See `src/http.ts` for the full route list.

## Next milestones

M2 multi-role channels and handoff · M3 GitHub/CI/webhook/Slack triggers · M4 approval gateway, action recording, network controls.
