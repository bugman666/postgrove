#!/usr/bin/env bash
# Local smoke for the #44 release gate: S1–S5 and S8.
# Requires: wrangler dev + migrate + seed (see README).
# No Cloudflare account. Mutates seed rows (delete / send / mint / close).
# Re-seed or reset .wrangler/state if a step 404s on a deleted seed id.
set -euo pipefail

BASE="${POSTGROVE_BASE_URL:-http://127.0.0.1:8787}"
COOKIE="${POSTGROVE_COOKIE_JAR:-/tmp/pg-smoke-cookies}"
OWNER_TOKEN="${OWNER_TOKEN:-change-me-local-owner-token}"
ADDRESS="${POSTGROVE_ADDRESS:-inbox@example.test}"
BOX="11111111-1111-4111-8111-111111111111"
MSG_WELCOME="22222222-2222-4222-8222-222222222221"
MSG_CODE="22222222-2222-4222-8222-222222222223"
MSG_REPLY="22222222-2222-4222-8222-222222222225"
ATTACH="33333333-3333-4333-8333-333333333331"
FAILED=0

json_get() {
  node --input-type=module -e '
    const fs = await import("node:fs");
    const path = process.argv[1];
    const raw = fs.readFileSync(0, "utf8");
    const data = JSON.parse(raw);
    const value = path.split(".").reduce((cur, key) => (cur == null ? undefined : cur[key]), data);
    if (value === undefined || value === null) process.exit(2);
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  ' "$1"
}

http() {
  local method="$1"
  local url="$2"
  shift 2
  curl -sS -o /tmp/pg-smoke-body -w "%{http_code}" -X "$method" "$url" "$@"
}

expect() {
  local step="$1"
  local want="$2"
  local got="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL $step: expected HTTP $want, got $got"
    echo "---- body ----"
    cat /tmp/pg-smoke-body || true
    echo
    FAILED=1
    return 1
  fi
  echo "PASS $step ($got)"
}

echo "== Postgrove smoke against $BASE =="

code="$(http GET "$BASE/healthz")"
if [[ "$code" != "200" ]]; then
  echo "FAIL healthz: Worker not ready (HTTP $code). Start wrangler after migrate + seed:"
  echo "  npm run db:migrate:local && npm run seed:local && npm run dev"
  cat /tmp/pg-smoke-body || true
  echo
  exit 1
fi
echo "PASS healthz (200)"

rm -f "$COOKIE"

# --- S1 Login ---
code="$(http GET "$BASE/auth/session")"
expect "S1 unauthenticated session" "401" "$code" || true

code="$(
  http POST "$BASE/auth/login" \
    -c "$COOKIE" \
    -H "content-type: application/json" \
    -d "{\"address\":\"$ADDRESS\",\"token\":\"$OWNER_TOKEN\"}"
)"
expect "S1 login" "200" "$code" || true
if [[ "$code" == "200" ]]; then
  role="$(json_get role < /tmp/pg-smoke-body || true)"
  if [[ "$role" != "owner" ]]; then
    echo "FAIL S1 login role: expected owner, got $role"
    FAILED=1
  fi
fi

code="$(http GET "$BASE/auth/session" -b "$COOKIE")"
expect "S1 session cookie" "200" "$code" || true

# --- S2 Inbox read / delete ---
code="$(http GET "$BASE/api/mailboxes" -b "$COOKIE")"
expect "S2 list mailboxes" "200" "$code" || true

code="$(http GET "$BASE/api/mailboxes/$BOX/messages" -b "$COOKIE")"
expect "S2 list inbox" "200" "$code" || true

code="$(http GET "$BASE/api/messages/$MSG_CODE" -b "$COOKIE")"
expect "S2 read" "200" "$code" || true

code="$(http GET "$BASE/api/messages/$MSG_WELCOME" -b "$COOKIE")"
if [[ "$code" == "200" ]]; then
  folder="$(json_get message.folder < /tmp/pg-smoke-body || true)"
  if [[ "$folder" == "trash" ]]; then
    echo "PASS S2 delete (seed welcome already in trash)"
  else
    code="$(http DELETE "$BASE/api/messages/$MSG_WELCOME" -b "$COOKIE")"
    expect "S2 delete to trash" "200" "$code" || true
  fi
elif [[ "$code" == "404" ]]; then
  echo "FAIL S2 welcome row missing. Reset local D1 and re-seed:"
  echo "  stop wrangler, rm -rf .wrangler/state, npm run db:migrate:local && npm run seed:local"
  FAILED=1
else
  expect "S2 read welcome before delete" "200" "$code" || true
fi

code="$(http GET "$BASE/api/mailboxes/$BOX/messages?folder=trash" -b "$COOKIE")"
expect "S2 trash list" "200" "$code" || true

# --- S3 Compose / Sent ---
SUBJECT="smoke-compose-$(date +%s)"
code="$(
  http POST "$BASE/api/send" \
    -b "$COOKIE" \
    -H "content-type: application/json" \
    -d "{\"to\":\"neighbor@example.test\",\"subject\":\"$SUBJECT\",\"text\":\"from local stub\"}"
)"
expect "S3 compose stub send" "200" "$code" || true
if [[ "$code" == "200" ]]; then
  status="$(json_get attempt.status < /tmp/pg-smoke-body || true)"
  if [[ "$status" != "\"sent\"" && "$status" != "sent" ]]; then
    echo "FAIL S3 attempt.status: $status"
    FAILED=1
  fi
fi
code="$(http GET "$BASE/api/mailboxes/$BOX/messages?folder=sent" -b "$COOKIE")"
expect "S3 sent folder" "200" "$code" || true
if ! grep -q "$SUBJECT" /tmp/pg-smoke-body; then
  echo "FAIL S3 sent folder missing subject $SUBJECT"
  FAILED=1
else
  echo "PASS S3 visible in Sent"
fi

# --- S4 Reply / forward ---
code="$(http GET "$BASE/api/messages/$MSG_REPLY/compose?mode=reply" -b "$COOKIE")"
expect "S4 reply prefill" "200" "$code" || true
if [[ "$code" == "200" ]]; then
  to="$(json_get draft.to < /tmp/pg-smoke-body || true)"
  subj="$(json_get draft.subject < /tmp/pg-smoke-body || true)"
  if [[ "$to" != *lead@grove.test* ]]; then
    echo "FAIL S4 reply To: $to"
    FAILED=1
  fi
  if [[ "$subj" != Re:* ]]; then
    echo "FAIL S4 reply subject: $subj"
    FAILED=1
  fi
fi

code="$(http GET "$BASE/api/messages/$MSG_REPLY/compose?mode=forward" -b "$COOKIE")"
expect "S4 forward prefill" "200" "$code" || true
if [[ "$code" == "200" ]]; then
  subj="$(json_get draft.subject < /tmp/pg-smoke-body || true)"
  if [[ "$subj" != Fwd:* && "$subj" != Fw:* ]]; then
    echo "FAIL S4 forward subject: $subj"
    FAILED=1
  fi
fi

FWD_SUBJECT="smoke-fwd-$(date +%s)"
code="$(
  http POST "$BASE/api/send" \
    -b "$COOKIE" \
    -H "content-type: application/json" \
    -d "{\"to\":\"neighbor@example.test\",\"subject\":\"$FWD_SUBJECT\",\"text\":\"fwd via stub\"}"
)"
expect "S4 stub send" "200" "$code" || true

# --- S5 Attachments ---
code="$(http GET "$BASE/attachments/$ATTACH" -b "$COOKIE")"
expect "S5 authenticated download" "200" "$code" || true

code="$(http GET "$BASE/attachments/$ATTACH")"
expect "S5 unauthenticated download" "401" "$code" || true

# --- S8 Dev API: create → wait(408) → extract OTP → close idempotent ---
code="$(
  http POST "$BASE/api/tokens" \
    -b "$COOKIE" \
    -H "content-type: application/json" \
    -d '{"label":"smoke-local"}'
)"
expect "S8 mint token" "201" "$code" || true
PG_TOKEN=""
if [[ "$code" == "201" ]]; then
  PG_TOKEN="$(json_get token.token < /tmp/pg-smoke-body || true)"
fi
if [[ -z "$PG_TOKEN" ]]; then
  echo "FAIL S8: no pg_ token minted"
  FAILED=1
else
  code="$(http GET "$BASE/api/v1" -H "Authorization: Bearer $PG_TOKEN")"
  expect "S8 catalog" "200" "$code" || true

  code="$(
    http POST "$BASE/api/v1/dev/inboxes" \
      -H "Authorization: Bearer $PG_TOKEN" \
      -H "content-type: application/json" \
      -d '{"ttl_seconds":900}'
  )"
  expect "S8 create inbox" "201" "$code" || true
  INBOX_ID=""
  INBOX_ADDR=""
  if [[ "$code" == "201" ]]; then
    INBOX_ID="$(json_get inbox.id < /tmp/pg-smoke-body || true)"
    INBOX_ADDR="$(json_get inbox.address < /tmp/pg-smoke-body || true)"
  fi
  if [[ -z "$INBOX_ID" || -z "$INBOX_ADDR" ]]; then
    echo "FAIL S8: create did not return inbox.id/address"
    FAILED=1
  else
    code="$(
      http POST "$BASE/api/v1/dev/inboxes/$INBOX_ID/wait" \
        -H "Authorization: Bearer $PG_TOKEN" \
        -H "content-type: application/json" \
        -d '{"timeout_ms":0,"contains":"482193"}'
    )"
    expect "S8 wait empty → 408" "408" "$code" || true

    MID="<smoke-otp-$(date +%s)@example.test>"
    code="$(
      curl -sS -o /tmp/pg-smoke-body -w "%{http_code}" \
        --request POST "$BASE/cdn-cgi/local/email" \
        --url-query "from=noreply@verify.test" \
        --url-query "to=$INBOX_ADDR" \
        --data-raw "From: noreply@verify.test
To: $INBOX_ADDR
Subject: your code
Date: Sat, 19 Sep 2026 12:00:00 +0000
Message-ID: $MID
Content-Type: text/plain; charset=utf-8

验证码：482193
"
    )"
    if [[ "$code" != "200" && "$code" != "202" && "$code" != "204" ]]; then
      echo "FAIL S8 local inbound (HTTP $code). Wrangler email endpoint required."
      cat /tmp/pg-smoke-body || true
      echo
      FAILED=1
    else
      echo "PASS S8 local inbound ($code)"
      code="$(
        http POST "$BASE/api/v1/dev/inboxes/$INBOX_ID/extract" \
          -H "Authorization: Bearer $PG_TOKEN" \
          -H "content-type: application/json" \
          -d '{"kind":"otp"}'
      )"
      expect "S8 extract OTP" "200" "$code" || true
      if [[ "$code" == "200" ]]; then
        otp="$(json_get extract.value < /tmp/pg-smoke-body || true)"
        if [[ "$otp" != "482193" ]]; then
          echo "FAIL S8 extract.value: $otp"
          FAILED=1
        fi
      fi
    fi

    code="$(
      http POST "$BASE/api/v1/dev/inboxes/$INBOX_ID/close" \
        -H "Authorization: Bearer $PG_TOKEN"
    )"
    expect "S8 close" "200" "$code" || true
    code="$(
      http POST "$BASE/api/v1/dev/inboxes/$INBOX_ID/close" \
        -H "Authorization: Bearer $PG_TOKEN"
    )"
    expect "S8 close idempotent" "200" "$code" || true
    if [[ "$code" == "200" ]]; then
      already="$(json_get already_closed < /tmp/pg-smoke-body || true)"
      if [[ "$already" != "true" ]]; then
        echo "FAIL S8 second close already_closed: $already"
        FAILED=1
      fi
    fi
  fi
fi

echo
if [[ "$FAILED" -ne 0 ]]; then
  echo "Smoke failed. See FAIL lines above."
  exit 1
fi
echo "Smoke passed: S1–S5 and S8."
