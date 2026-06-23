import { createServer } from "node:http";

export function createNodeServer(
  port: number,
  app: { fetch(request: Request): Promise<Response> },
  serviceName: string,
) {
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
    console.log(`${serviceName} listening on ${port}`);
  });

  return server;
}
