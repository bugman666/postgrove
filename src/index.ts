import type { Env, InboundEmail } from "./env";
import { handleApi } from "./api";
import { ATTACHMENT_CSS, handleAttachmentRoutes } from "./attachments";
import { handleAdmin } from "./admin.ts";
import { handleAuthRoutes } from "./auth";
import { isEmptyInboxAssetPath } from "./brand-assets.ts";
import { serveEmptyInboxAsset } from "./brand-assets-serve.ts";
import { brandOverrideCss, loadBranding } from "./branding.ts";
import { handleHealth } from "./health";
import { css } from "./http";
import { handleInbound } from "./inbound";
import { handleRestRoutes } from "./rest";
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
      const brand = await loadBranding(env);
      return css(APP_CSS + ATTACHMENT_CSS + brandOverrideCss(brand.accent));
    }

    if (request.method === "GET" && isEmptyInboxAssetPath(url.pathname)) {
      return serveEmptyInboxAsset();
    }

    const auth = await handleAuthRoutes(request, env);
    if (auth) {
      return auth;
    }

    const rest = await handleRestRoutes(request, env);
    if (rest) {
      return rest;
    }

    const attachment = await handleAttachmentRoutes(request, env, url);
    if (attachment) {
      return attachment;
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, url);
    }

    return handleUi(request, env, url);
  },

  async email(message: InboundEmail, env: Env): Promise<void> {
    await handleInbound(message, env);
  },
};
