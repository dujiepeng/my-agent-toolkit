import { createServer } from "node:http";
import { createBotHostServer } from "./server.js";

function createNodeServer(port: number, app: { fetch(request: Request): Promise<Response> }) {
  const server = createServer(async (req, res) => {
    const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url ?? "/"}`;
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const request = new Request(url, {
      method: req.method,
      headers: req.headers as HeadersInit,
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    });

    const response = await app.fetch(request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`bot-host api listening on ${port}`);
  });

  return server;
}

export function startBotApiMain(): void {
  const port = Number.parseInt(process.env.PORT ?? "8400", 10);
  const app = createBotHostServer({
    dataServiceUrl: process.env.DATA_SERVICE_URL ?? "http://data-service:8300",
    llmRunnerUrl: process.env.LLM_RUNNER_URL ?? "http://llm-runner:8200",
    logServiceUrl: process.env.LOG_SERVICE_URL,
    fetch,
  });

  createNodeServer(port, app);
}
