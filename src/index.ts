import type { Env, InboundEmail } from "./env";
import { handleHealth } from "./health";
import { handleInbound } from "./inbound";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return handleHealth(env);
    }

    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },

  async email(message: InboundEmail, env: Env): Promise<void> {
    await handleInbound(message, env);
  },
};
