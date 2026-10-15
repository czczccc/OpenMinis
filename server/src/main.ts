import { AgentRuntime } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { createServer } from "./http.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";

const config = loadConfig();
const store = new Store(config.dataDir);
const agent = new AgentRuntime(config, store);
const scheduler = new Scheduler(store, agent);
await scheduler.start();

const server = createServer(config, store, agent, scheduler);
server.listen(config.port, () => {
  console.log(`openminis-server on :${config.port} (sandbox=${config.sandbox}, data=${config.dataDir})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    scheduler.stop();
    server.close(() => process.exit(0));
  });
}
