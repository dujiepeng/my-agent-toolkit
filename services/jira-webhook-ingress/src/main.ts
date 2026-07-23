import { createServer } from "node:http";
import { createJiraWebhookIngressServer } from "./server.js";

const port = positiveInteger(process.env.PORT, 9000);
const app = createJiraWebhookIngressServer({
  runnerUrl: (process.env.JIRA_AUTOMATION_RUNNER_URL ?? "http://jira-automation-runner:8910").replace(/\/+$/, ""),
  sharedSecret: process.env.JIRA_WEBHOOK_SHARED_SECRET,
  internalToken: process.env.JIRA_AUTOMATION_INTERNAL_TOKEN ?? "",
});

const server = createServer(async (req, res) => {
  const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url ?? "/"}`;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const response = await app.fetch(new Request(url, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  }));
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`jira-webhook-ingress listening on ${port}`);
});

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`expected positive integer: ${value}`);
  return parsed;
}
