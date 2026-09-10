# Hicks acceptance runbook

This is the operator checklist for the live acceptance pass. It is deliberately
separate from the implementation: the commands collect evidence and stop on a
failed gate. Use a fresh proof directory for every run and store only redacted
JSON, timings, and identifiers. Never print tokens, proxy URLs, cookies, or
private message text.

The live Telegram part is **blocked until the proxy policy is PASS**. The
commands below prepare and exercise local or synthetic paths first; they do not
send a user-visible Telegram message by themselves.

## 1. Prepare an isolated proof directory

```sh
set -eu
PROOF_DIR="$(mktemp -d /tmp/hicks-acceptance.XXXXXX)"
export PROOF_DIR
umask 077
git rev-parse HEAD | tee "$PROOF_DIR/source-sha.txt"
git diff --check
```

Run the checked-in deployment transaction tests before touching an installed
runtime:

```sh
node scripts/run-vitest.mjs test/scripts/hicks-deploy-runtime.test.ts \
  | tee "$PROOF_DIR/deploy-fixture.log"
```

The fixture must report four passing cases: dry-run leaves the install and
state untouched, a successful cutover preserves the reference bundle and its
backup, a failed post-cutover smoke restores both old bundles while retaining
the failed new bundles, and a missing workspace fails closed. This is the
reproducible rollback proof for
`scripts/hicks-deploy-runtime.mjs`.

## 2. Proxy policy gate (run on the managed Gateway host)

The proxy is a required dependency for both Codex and Telegram. A listener or a
Gateway `active` state is not enough. First inspect the Gateway process and,
after a managed Codex request exists, the actual child process. The following
prints only `configured`, `wrong-or-absent`, or `missing`:

```sh
gw_pid="$(systemctl show -p MainPID --value openclaw-gateway.service)"
test "$gw_pid" -gt 0
tr '\0' '\n' < "/proc/$gw_pid/environ" |
  awk -F= '/^(HTTP|HTTPS|ALL)_PROXY=/{
    print $1 "=" ($2 ~ /:17890([/?]|$)/ ? "configured" : "wrong-or-absent")
  }' | sort | tee "$PROOF_DIR/gateway-proxy-env.txt"

test "$(wc -l < "$PROOF_DIR/gateway-proxy-env.txt")" -ge 3
! grep -q 'wrong-or-absent' "$PROOF_DIR/gateway-proxy-env.txt"
```

Record the PID of the managed Codex app-server child from the Gateway-owned
process relationship, then inspect only its proxy variable names and state:

```sh
ps -eo pid=,ppid=,comm= |
  awk -v ppid="$gw_pid" '$2 == ppid {print}' > "$PROOF_DIR/gateway-children.txt"
# Set codex_pid to the app-server child PID from that redacted process list.
: "${codex_pid:?set the managed Codex app-server PID from gateway-children.txt}"
tr '\0' '\n' < "/proc/$codex_pid/environ" |
  awk -F= '/^(HTTP|HTTPS|ALL)_PROXY=/{
    print $1 "=" ($2 ~ /:17890([/?]|$)/ ? "configured" : "wrong-or-absent")
  }' | sort | tee "$PROOF_DIR/codex-proxy-env.txt"
! grep -q 'wrong-or-absent' "$PROOF_DIR/codex-proxy-env.txt"
```

The child check is required because the Codex managed app-server inherits the
parent environment at spawn time. That inheritance is visible in
`../codex/codex-rs/app-server-daemon/src/backend/pid.rs` and
`../codex/codex-rs/app-server-test-client/src/lib.rs`; it still must be proved
against the live PID.

## 3. Fresh Hicks policy asset and workspace gate

The bounded owner policy is a deploy input, not a claim about runtime behavior.
The checked-in owner flow stages `customization/hicks/OWNER_POLICY.md` and
`customization/hicks/HICKS_ORCHESTRATOR_TOOL_POLICY.json`,
`HICKS_ARCHITECTURE_PLAN.md`, and `WORKLOG.md` atomically under the configured
live workspace's `hicks-reference/` directory, with a backup and failed bundle.
The per-session normative contract is emitted by the canonical
`src/agents/system-prompt.ts` owner-policy section; the reference files are not
pasted wholesale into prompts. Do not deploy them into the historical
`/home/clawd/.openclaw/workspace` tree.

The asset is intentionally short enough for a per-session normative contract;
the full `HICKS_ARCHITECTURE_PLAN.md` and `WORKLOG.md` stay reference material.
Check the bound before staging, without printing the policy contents:

```sh
policy="customization/hicks/OWNER_POLICY.md"
test -s "$policy"
test "$(wc -w < "$policy")" -le 700
test "$(wc -c < "$policy")" -le 5000
```

After the asset is installed, create a fresh `main` session and ask for the
operating contract. Save only a redacted response and verify that it states the
Front/Orchestrator/Workboard/Luna ownership, proxy-only egress, owner/admin
boundary, inline confirmation rule, and Front-only exactly-once completion.
Then compare the answer with a read-only board/session/proxy trace from the same
run. The answer must describe observed behavior rather than make the asset
itself the proof:

```sh
fresh_key="hicks-policy-fresh-$(date +%s)"
openclaw agent --agent main --session-key "$fresh_key" --thinking off --json \
  --message 'State the Hicks operating contract in seven bullets: ownership, worker model, proxy requirement, admin authorization, inline confirmation, completion sender, and reference files.' \
  > "$PROOF_DIR/fresh-policy-session.json"
jq -e '.status == "ok" and ((.result // .reply // .text) | type == "string")' \
  "$PROOF_DIR/fresh-policy-session.json" >/dev/null
```

The fresh session must resolve the active workspace to
`/home/clawd/.openclaw/obsidian-operating-base`; the older workspace path is a
stale-source failure. The fresh answer must match the canonical owner-policy
section and the observed routing. The full plan and worklog may be opened as
references, but neither may be injected wholesale into the fresh prompt. A
failed reference cutover, stale workspace, over-bound policy, or mismatch
between the answer and the observed routing blocks deploy.

If a private proxy probe is needed, keep the URL in an environment variable and
emit only status and elapsed time:

```sh
: "${HICKS_PROXY_URL:?set the private proxy URL in the shell only}"
for target in https://api.telegram.org/ https://api.openai.com/v1/models; do
  curl --proxy "$HICKS_PROXY_URL" --max-time 10 --silent --show-error \
    -o /dev/null -w '%{http_code} %{time_total}\n' "$target"
done | tee "$PROOF_DIR/proxy-probes.txt"
unset HICKS_PROXY_URL
```

Any direct or sticky fallback in the Telegram transport is a policy failure;
stop here and repair the proxy owner before deployment:

```sh
rg -n 'mode: "direct"|direct sticky|proxy.*fallback|undici' \
  extensions/telegram/src/fetch.ts
```

## 4. Reproducible bundle deploy and rollback

Use a clean, built source tree and set the install root explicitly. The updater
delegates to `scripts/hicks-deploy-runtime.mjs`, which stages the complete
bundle, validates the Codex contract, cuts over atomically, runs the bounded
smoke marker, and restores the old bundle on a failed start or smoke. The
runtime state directory and Hicks workspace must be outside the install root;
the deploy owner resolves both through existing realpaths and rejects symlinked
descendants. Legacy `dist.pre-*` and versioned stage/backup directories are
excluded from the next canonical install. After cutover they are moved into
`$HICKS_STATE_DIR/hicks-install-legacy-backups/<stamp>/` with a manifest and
restored if rollback is needed.

Prepare and inspect the stage without changing an install:

```sh
node scripts/hicks-deploy-runtime.mjs \
  --source-root "$PWD" \
  --install-root "$HICKS_INSTALL_ROOT" \
  --state-dir "$HICKS_STATE_DIR" \
  --workspace-root "$HICKS_WORKSPACE_ROOT" \
  --dry-run | tee "$PROOF_DIR/deploy-dry-run.log"
```

After the proxy gate is PASS and the owner has selected the exact source SHA,
the live transaction is:

```sh
: "${HICKS_INSTALL_ROOT:?set the private install root}"
: "${HICKS_STATE_DIR:?set the private state root}"
: "${HICKS_WORKSPACE_ROOT:?set the configured live main workspace root}"
test "$(git status --porcelain)" = ""
export OPENCLAW_UPDATE_INSTALL_ROOT="$HICKS_INSTALL_ROOT"
export OPENCLAW_UPDATE_WORKSPACE_ROOT="$HICKS_WORKSPACE_ROOT"
export OPENCLAW_UPDATE_STATE_DIR="$HICKS_STATE_DIR"
scripts/update-gateway.sh 2>&1 | tee "$PROOF_DIR/deploy-live.log"
unset OPENCLAW_UPDATE_INSTALL_ROOT
unset OPENCLAW_UPDATE_WORKSPACE_ROOT
unset OPENCLAW_UPDATE_STATE_DIR
```

Do not manually rename the install tree. On failure, retain the printed backup
and failed-bundle paths and attach their manifest hashes to the proof. The
fixture above is the rollback rehearsal; a live deployment is a separate gate
and is intentionally not run during preparation.

## 5. Gateway readiness and managed planes

Capture all three HTTP boundaries and the authenticated CLI probes. The local
HTTP responses must satisfy the documented `ok` contract:

```sh
curl --fail --silent http://127.0.0.1:18789/healthz > "$PROOF_DIR/healthz.json"
curl --fail --silent http://127.0.0.1:18789/startupz > "$PROOF_DIR/startupz.json"
curl --fail --silent http://127.0.0.1:18789/readyz  > "$PROOF_DIR/readyz.json"
jq -e '.ok == true' "$PROOF_DIR/healthz.json" "$PROOF_DIR/startupz.json" "$PROOF_DIR/readyz.json" >/dev/null

openclaw gateway status --deep --json > "$PROOF_DIR/gateway-status.json"
openclaw health --json > "$PROOF_DIR/gateway-health.json"
openclaw channels status --probe --json > "$PROOF_DIR/channel-probe.json"
```

`/readyz` must be ready for the configured channels; `healthz` alone is only a
liveness result. If any command fails, preserve the JSON and stop before
orchestration.

## 6. Synthetic depth and overlap proof

Run this through the existing local Control UI/Gateway session with a
non-secret marker such as `HICKS_ACCEPTANCE_RUN=<uuid>`. The prompt must ask
the `hicks-orchestrator` to create one parent card, decompose it into at least
three independent child cards, dispatch all children concurrently to native
Luna workers, heartbeat each claim, and attach terminal proof. Workers must
return to the orchestrator; they must not contact Telegram.

After completion, collect the bounded operator views:

```sh
openclaw gateway call workboard.cards.list \
  --params '{"boardId":"hicks-front"}' --json > "$PROOF_DIR/workboard-cards.json"
openclaw gateway call workboard.cards.diagnostics \
  --params '{}' --json > "$PROOF_DIR/workboard-diagnostics.json"
openclaw gateway call tasks.list \
  --params '{"agentId":"hicks-orchestrator","limit":100}' --json > "$PROOF_DIR/orchestrator-tasks.json"
openclaw gateway call sessions.list \
  --params '{"agentId":"hicks-orchestrator","archived":false}' --json > "$PROOF_DIR/orchestrator-sessions.json"
```

For each parent and child, save `workboard.cards.runs` using the card `id`:

```sh
openclaw gateway call workboard.cards.runs \
  --params '{"id":"<card-id>"}' --json > "$PROOF_DIR/card-<card-id>-runs.json"
```

Acceptance requires one parent at depth 0/Front, one distinct orchestrator at
depth 1, at least three native Luna child sessions at depth 2, the same parent
run identity, distinct child claims, and overlapping execution intervals:
`max(child.startAt) < min(child.endAt)`. The proof must show claim owner,
heartbeat/expiry, run/session link, worker log, and terminal status for every
child. A process list or a bare success text is not sufficient.

Refresh Companion and record a fresh board view after the run. The visible
cards must contain the same IDs and terminal fields as the Gateway projection;
an old screenshot or a reconnecting shell is not acceptance evidence.

## 7. Exactly-once completion and responsiveness

Before the run, create a Workboard notification subscription for the exact
parent card or run and event kinds `completed`, `failed`, and `stale`. Poll
`workboard.notifications.events` without advancing, then advance with
`workboard.notifications.advance` only after recording the event. Assert one
terminal completion event for the parent and one completion event per child.
The second read after advancing must be empty.

The operator RPC sequence is:

```sh
openclaw gateway call workboard.notifications.subscribe \
  --params '{"cardId":"<parent-card-id>","target":"session:<front-session-key>","eventKinds":["completed","failed","stale"]}' \
  --json > "$PROOF_DIR/notification-subscription.json"
subscription_id="$(jq -r '.subscription.id' "$PROOF_DIR/notification-subscription.json")"
openclaw gateway call workboard.notifications.events \
  --params "{\"subscriptionId\":\"$subscription_id\",\"limit\":200}" --json \
  > "$PROOF_DIR/notification-preview.json"
# After recording the preview, advance exactly once, then read again.
openclaw gateway call workboard.notifications.advance \
  --params "{\"subscriptionId\":\"$subscription_id\",\"limit\":200}" --json \
  > "$PROOF_DIR/notification-advance.json"
openclaw gateway call workboard.notifications.events \
  --params "{\"subscriptionId\":\"$subscription_id\",\"limit\":200}" --json \
  > "$PROOF_DIR/notification-after-advance.json"
jq -e '(.events // []) == []' "$PROOF_DIR/notification-after-advance.json" >/dev/null
```

The Front session must show one completion wake carrying the parent correlation
ID, and one final delivery decision. Inspect the exact task with
`tasks.get`, and inspect the Front session using the existing session history
view; do not infer delivery from `sessions.list` or a running process.

While at least one child is deliberately long-running, issue independent
read-only `health` and `status --deep` probes at 250 ms intervals. Record the
maximum response time and failures. The Front remains responsive only when
these probes continue to complete and the Front can accept a second status
turn while the long task is running.

The final Telegram DM and duplicate-update replay are a future live gate. Use
the `$telegram-e2e-userbot` runner with a leased Test Server user and its
`events.ndjson`/`summary.json`; require exactly one final outbound DM tied to
the correlation ID. Do not substitute `getMe`, browser state, or Gateway
health for outbound evidence. This runbook does not invoke that runner during
preparation.

## 8. Inline timing and transport abort

The current Telegram E2E runner has `send`, `click`, `restartGateway`, and
bounded API-hold scenario actions, but no inline-query/chosen-result driver.
Therefore inline acceptance is currently **BLOCKED**, rather than falsely
passing through a normal DM. Add the missing real-user driver before claiming
this gate. The live measurement must collect at least 20 timelines and compute
the p95 from Telegram event timestamps:

- inline placeholder first answer: p95 <= 2 s;
- transport hard abort: 9 s;
- total response: < 13 s.

The existing bounded API-hold scenario can exercise callback commit/release
semantics locally. Pair it with the real Telegram event stream once the inline
driver exists; assert the callback commit occurs once and the final DM occurs
once after release.

## 8a. Passive A/B owner capture (no Telegram action by the operator)

This is the capture procedure for two ordinary owner DMs and one inline query.
The operator sends the messages manually; the capture side only reads the
Gateway journal, session history, Workboard projections, and the existing
Telegram event stream. Run it from the actual Hicks Gateway/WSL owner, not from
the Armbian LAN jump host. Keep the proof directory mode `0700` and redact
message text, tokens, proxy values, and claim tokens.

Start capture before the first message and leave it running until both parents
are terminal and the inline result has been selected:

```sh
set -eu
PROOF_DIR="${PROOF_DIR:?use the fresh proof directory from section 1}"
umask 077
date -Is > "$PROOF_DIR/capture-start.txt"
systemctl show openclaw-gateway.service -p MainPID -p ActiveState -p ActiveEnterTimestamp \
  > "$PROOF_DIR/gateway-owner.txt"
curl --fail --silent http://127.0.0.1:18789/readyz > "$PROOF_DIR/readyz-before.json"
openclaw gateway call workboard.cards.list --params '{"boardId":"hicks-front"}' --json \
  > "$PROOF_DIR/workboard-before.json"
openclaw logs --follow --json > "$PROOF_DIR/gateway-log.jsonl" 2>"$PROOF_DIR/gateway-log.stderr" &
LOG_PID=$!
trap 'kill "$LOG_PID" 2>/dev/null || true' EXIT
```

After the operator reports that both DMs and the inline selection were sent,
stop the journal capture and take a consistent read-only snapshot. The log
records have their own timestamp; `isolated polling ... update received` (or
the webhook equivalent) is the ingress boundary, `telegram inline timing` is
the inline boundary, and the Front session history plus Workboard launch
association is the authoritative ACK/correlation boundary.

```sh
kill "$LOG_PID" 2>/dev/null || true
date -Is > "$PROOF_DIR/capture-end.txt"
openclaw gateway call workboard.cards.list --params '{"boardId":"hicks-front"}' --json \
  > "$PROOF_DIR/workboard-after.json"
openclaw gateway call workboard.cards.diagnostics --params '{}' --json \
  > "$PROOF_DIR/workboard-diagnostics.json"
openclaw gateway call sessions.list --params '{"agentId":"hicks-orchestrator","archived":false}' --json \
  > "$PROOF_DIR/orchestrator-sessions.json"
openclaw gateway call tasks.list --params '{"agentId":"hicks-orchestrator","limit":100}' --json \
  > "$PROOF_DIR/orchestrator-tasks.json"
```

For every parent id in `workboard-after.json`, save its run projection and
retain the Front session history containing the acceptance reply and completion
wake. The acceptance table is derived only from these records:

```sh
for id in $(jq -r '.cards[]?.id // empty' "$PROOF_DIR/workboard-after.json"); do
  openclaw gateway call workboard.cards.runs --params "{\"id\":\"$id\"}" --json \
    > "$PROOF_DIR/card-$id-runs.json"
done
rg -n 'isolated polling (worker )?(update received|inline fast-path update received)|telegram inline timing|telegram inline task committed' \
  "$PROOF_DIR/gateway-log.jsonl" > "$PROOF_DIR/telegram-timing-lines.txt" || true
```

The two normal DMs pass the admission portion only when the capture shows two
distinct ingress/update records, two fast Front ACKs, two distinct parent card
ids and parent run ids, and both parents accepted before either reaches
terminal. The worker portion requires distinct native child session/run ids,
configured `gpt-5.6-luna` in each worker attempt, heartbeat events, child status
transitions, worker logs, and overlapping child intervals. The final-delivery
portion requires two Front completion wakes and two user-visible final DMs tied
to the same parent ids. A service `active` line, a `getMe`, or a browser view is
not any of these proofs.

For the inline query, use the `telegram inline timing` JSON fields directly:
`ingressAgeMs` measures receipt to placeholder-answer start,
`answerMs` measures the Bot API answer, and the callback/chosen records identify
the commit. Require one placeholder answer, one callback/chosen commit, one
accepted task result, and total Telegram response under 13 seconds. If the
capture has no chosen/callback event, record `BLOCKED` with the exact external
Inline Feedback/BotFather prerequisite; do not reinterpret an ordinary DM as
inline evidence.

Two short read-only owner prompts for the manual A/B run are:

```text
HICKS_ACCEPTANCE_A: Проведи только read-only аудит доступности Windows-ноды и верни наблюдаемые статусы, без изменений.
HICKS_ACCEPTANCE_B: Проведи только read-only аудит прокси-маршрута до OpenAI и верни задержки по этапам, без изменений.
```

## 9. Restart/replay and recovery matrix

For a controlled run, record the Gateway generation and active parent/child
identities, then use the documented suspend/restart flow. After restart, repeat
the readiness probes, read the same Workboard cards and task IDs, and inspect
the notification cursor. Replay the exact inbound idempotency key once: it must
return the existing parent/run and produce no second worker set or outbound
DM. Any stale worker must be fenced before a new claim is accepted.

The final recovery matrix is PASS only with fresh evidence for each plane:

| Plane                | Probe                                                              | Required result                                                 |
| -------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| Windows native node  | `openclaw nodes status --connected` and typed `device.status`      | connected, authorized, typed call succeeds                      |
| Browser node         | `openclaw browser --json status`, `tabs`, `snapshot --interactive` | user-session browser and authenticated iCloud tab remain usable |
| iCloud action        | existing typed browser/node action                                 | action result is returned through the orchestrator              |
| Companion            | fresh app status, board refresh, visible card snapshot             | reconnects and shows current terminal card fields               |
| Gateway restart      | suspend, restart, readiness, Workboard replay                      | no duplicate worker or final delivery                           |
| network interruption | controlled proxy/network interruption                              | bounded failure, durable replay, no direct bypass               |

Use the authoritative Gateway/node/browser planes for these checks. Do not add
WSL-to-Windows SSH as a new execution path.

## Acceptance verdict

The run is complete only when every row in the architecture acceptance matrix
is `PASS`, or has a reproducible `BLOCKED` record naming the owner, exact
missing prerequisite, and next command. Preparation is complete when the
deployment fixture passes, the command set above is ready, and all current
blockers are recorded in `WORKLOG.md`.
