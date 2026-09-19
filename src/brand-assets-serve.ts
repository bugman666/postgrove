import emptyInboxJpg from "../docs/assets/pg-empty-inbox.jpg";

/** Serve the brand still bundled next to the Worker (same file as docs/assets). */
export function serveEmptyInboxAsset(): Response {
  return new Response(emptyInboxJpg, {
    status: 200,
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
}
