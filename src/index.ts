import type { Env, InboundEmail } from "./env";
import { handleApi } from "./api";
import { ATTACHMENT_CSS, handleAttachmentRoutes } from "./attachments";
import { handleAuthRoutes } from "./auth";
import { handleHealth } from "./health";
import { css } from "./http";
import { handleInbound } from "./inbound";
import { APP_CSS } from "./styles";
import { handleUi } from "./ui";

export { requireAdmin, requireAdminOrOwner, requireOwner } from "./auth";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return handleHealth(env);
    }

    if (request.method === "GET" && url.pathname === "/app.css") {
      return css(APP_CSS + ATTACHMENT_CSS);
    }

    const auth = await handleAuthRoutes(request, env);
    if (auth) {
      return auth;
    }

    const attachment = await handleAttachmentRoutes(request, env, url);
    if (attachment) {
      return attachment;
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    return handleUi(request, env, url);
  },

  async email(message: InboundEmail, env: Env): Promise<void> {
    await handleInbound(message, env);
  },
};
