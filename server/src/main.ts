import { startServer } from "./index.js";
import { log } from "./log.js";

startServer().catch((err) => {
  log.error({ err: err?.message ?? err }, "failed to start");
  process.exit(1);
});
