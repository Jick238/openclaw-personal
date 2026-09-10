# Guest Mode

Guest Mode is an explicit, single-turn smoke lane. It starts only when the
runner is passed `--guest`; ordinary probes never change behavior. The runner
first calls the leased SUT bot's `getMe` and requires
`supports_guest_queries: true`. Missing or false is a deterministic
`status: "blocked"` result (exit code 2); the runner sends no Telegram
message. This is expected when the Test Server lease has no Guest Mode
entitlement, and is not a test pass.

The guest lane always targets the TDLib user's `self` chat (Saved Messages).
`--chat` and `--dm` are rejected, so a stale configured group or bot DM cannot
receive the probe. The text must mention the leased SUT bot, for example:

```sh
node .agents/skills/telegram-e2e-userbot/scripts/run-mock-sut-user-e2e.mjs \
  --guest --text '@{sut} Reply exactly: USER-E2E-{run}' \
  --timeout-ms 60000 \
  --record "$TELEGRAM_E2E_PROOF_DIR/guest-mode/events.ndjson" \
  --output "$TELEGRAM_E2E_PROOF_DIR/guest-mode/summary.json"
```

A passing summary requires all three independent facts:

- the TDLib recorder observes a message from the leased SUT bot in Saved Messages;
- the local Test Bot API proxy observes a successful `answerGuestQuery` call;
- `mock-openai-requests.ndjson` contains a provider request.

The Bot API contract defines `supports_guest_queries` on `getMe`, delivers a
`guest_message` update, and exposes `answerGuestQuery`; the Test Server must
actually return the capability for this recipe to be reachable. If it does
not, preserve the blocked summary and record the lease/entitlement as the
missing prerequisite. Do not synthesize a `guest_message` or call
`answerGuestQuery` directly as a substitute for Telegram delivery.
