-- inbound_hooks.webhook_secret is stored enveloped at rest (enc:v1: AES-GCM,
-- key derived from SESSION_SECRET). Mint / rotate still returns plaintext once.
-- One-way hash would break outbound HMAC-SHA256 signing, so this is an envelope.
--
-- Leftover plaintext rows (pre-0014) are wrapped on the next read or save.
-- Operators who must not wait for lazy upgrade should rotate those hooks after deploy.
-- Rotating SESSION_SECRET makes existing envelopes unreadable — rotate hook secrets too.
--
-- Schema unchanged (TEXT column). This file records the contract so 0014 is applied.

UPDATE inbound_hooks SET webhook_secret = webhook_secret WHERE 0;
