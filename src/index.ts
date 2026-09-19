import type { Env, InboundEmail } from "./env";
import { handleAuthRoutes } from "./auth";
import { handleHealth } from "./health";
import { handleInbound } from "./inbound";

export { requireAdmin, requireAdminOrOwner, requireOwner } from "./auth";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return handleHealth(env);
    }

    const auth = await handleAuthRoutes(request, env);
    if (auth) {
      return auth;
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
