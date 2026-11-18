import { buildApp } from "./app.js";
import { closeDb } from "./db.js";

const port = Number(process.env.PORT || 8787);
const app = await buildApp();
const address = await app.listen({ port, host: "127.0.0.1" });
console.log(`Poros Enterprise API: ${address}`);
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    await closeDb();
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
  }
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
