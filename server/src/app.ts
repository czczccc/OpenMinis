import { AgentRuntime } from "./agent.ts";
import { Approvals } from "./approvals.ts";
import { BrowserPool } from "./browser.ts";
import { Channels } from "./channels.ts";
import type { Config } from "./config.ts";
import { Connectors } from "./connectors.ts";
import { createServer, type Services } from "./http.ts";
import { Notifiers } from "./notify.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import { Tasks } from "./tasks.ts";
import { Triggers } from "./triggers.ts";

/** Wire every service together; used by main.ts and the tests. */
export async function createApp(config: Config, opts: { telegramApi?: string } = {}) {
  const store = new Store(config.dataDir);
  const approvals = new Approvals(config.dataDir, config.approvalTimeoutMs);
  const connectors = new Connectors(config.dataDir);
  await connectors.reload();
  const browser = config.browser ? new BrowserPool(config.chromiumPath, config.recordBrowser) : undefined;
  const agent = new AgentRuntime(config, store, { approvals, browser, connectors });
  const channels = new Channels(store, agent);
  const tasks = new Tasks(config.dataDir, agent, channels);
  const notifiers = new Notifiers(config.dataDir, approvals, tasks, opts.telegramApi);
  tasks.setNotifiers(notifiers);
  const triggers = new Triggers(config.dataDir, tasks);
  const scheduler = new Scheduler(store, tasks);

  await tasks.start();
  await notifiers.start();
  await scheduler.start();

  const services: Services = { config, store, scheduler, channels, tasks, approvals, connectors, notifiers, triggers };
  const server = createServer(services);
  const stop = async () => {
    scheduler.stop();
    notifiers.stop();
    await browser?.closeAll();
    await connectors.closeAll();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { ...services, agent, browser, server, stop };
}
