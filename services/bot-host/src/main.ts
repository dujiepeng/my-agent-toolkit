import { startBotApiMain } from "./botApiMain.js";
import { startWeComWorkerMain } from "./wecomWorkerMain.js";

const mode = process.env.BOT_HOST_MODE ?? "api";

if (mode === "worker") {
  startWeComWorkerMain();
} else {
  startBotApiMain();
}
