import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const app = await createApp(config);
app.server.listen(config.port, () => {
  console.log(`openminis-server on :${config.port} (sandbox=${config.sandbox}, browser=${config.browser}, data=${config.dataDir})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    // Running tasks stay "running" on disk and resume on the next start.
    app.stop().finally(() => process.exit(0));
  });
}
