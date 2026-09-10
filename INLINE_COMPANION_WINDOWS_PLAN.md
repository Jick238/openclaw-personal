# План восстановления и доработки Hicks

Дата: 2026-09-06. Основание: `WORKLOG.md`, локальный исходный код и измерения live-маршрута. Этот документ описывает следующий development pass; новые live-изменения в рамках аудита не выполняются.

## A. Telegram model-backed inline mode

### Подтверждённое состояние

Live `channels status --probe --json` показал account `ready`, polling и Bot API capability `supportsInlineQueries=true`. В исходнике `extensions/telegram/src/allowed-updates.ts:9-17` inline update types приходят через grammY defaults, но `extensions/telegram/src/bot-handlers.inbound-pipeline.ts:425-436` регистрирует только message/edited-message/channel-post handlers. Inline buttons — отдельная функция.

### Реализация по фазам

1. Core owner: в `src/channels/plugins/channel-runtime-surface.types.ts` определить узкий `externalTurns.runResultOnly` request/result contract. Запрос должен содержать immutable `runId`, `sessionId/sessionKey`, `agentId`, account/channel/sender, prompt и timeout. Результат — `completed(text)`, `empty`, `timed_out`, `failed(message)`.
2. Пополнить реальный bound runtime в `src/plugins/runtime/runtime-channel.ts` и его создание в `src/plugins/runtime/index.ts`. Owner вызывает canonical `PluginRuntime.agent.runEmbeddedAgent`, выставляя result-only/no-normal-delivery policy, отключая message tool и фильтруя bounded non-commentary final text. Нельзя импортировать Telegram internal runner или Codex runtime.
3. Протянуть capability через `src/gateway/server-channels.ts` и `ChannelGatewayContext`, затем через `extensions/telegram/src/channel.ts`, `monitor.types.ts`, `monitor.ts`, `webhook.ts`, `bot.types.ts`, `bot-core.ts`, `bot-handlers.types.ts`. Все существующие callers сохраняют optional behavior; inline handler fail-closed при отсутствии capability.
4. Добавить `inline_query` handler рядом с `registerTelegramInboundHandlers` в `extensions/telegram/src/bot-handlers.inbound-pipeline.ts`. Авторизация использует тот же sender/DM policy owner, но не фабрикует `Message` и не запускает обычную chat delivery. Stable session key: account + Telegram sender id + inline surface; query id — correlation/dedupe key.
5. Добавить bounded timeout, in-flight/terminal dedupe по `inline_query.id`, empty/loading/error `InlineQueryResultArticle`, и ровно один `ctx.answerInlineQuery(...)`. `chosen_inline_result` оставить выключенным до отдельного persistence/reply-context контракта.

### Тесты и live rollout

Тесты: core wrapper admission/result filtering/timeout/error; channel-surface forwarding; Telegram authorization, empty query, successful result, duplicate query id, timeout/error и exactly-once answer. Затем live BotFather вручную: `/setinline` для `@hickss_bot` — это единственное внешнее действие, которое нельзя выполнять кодом.

При откате удалить capability и inline registration, не менять обычный message pipeline. Риск production LOC: core contract + owner wrapper + wiring + Telegram adapter; не добавлять конфиг. Приёмка: inline query от авторизованного sender возвращает один article с model result; повтор query id не вызывает второй turn/answer; обычные Telegram messages и native subagents не меняются; трасса подтверждает native OpenClaw run, без Codex internal spawn.

## B. Mac Companion

### Подтверждённое состояние

`/Users/wholewnewpea/.openclaw/state/openclaw.sqlite` содержал `device_identities` с canonical columns, но без `STRICT`; integrity был `ok`, rows — 0. Сохранён backup `/tmp/hicks-companion-before-20260906/openclaw.sqlite`. Таблица перестроена в `STRICT`, index восстановлен, integrity снова `ok`; `/Users/wholewnewpea/.openclaw/openclaw.json` уже указывал на direct WSS Gateway с прежним token source.

После двух безопасных relaunch OpenClaw.app UI всё ещё показывал `Dashboard reconnecting — Waiting for a fresh authenticated connection`; это не доказательство рабочего remote identity. Read-only authoritative `devices list --json` показывает `pending: []`: нового pending Companion approval нет. Есть approved paired macOS UI records с label `MacBook Pro` / client `openclaw-macos`, но они `connected: false`; точный gap — local identity/remote handshake, а не ожидающее approval устройство.

### Следующий шаг и приёмка

Approval не выполнять: authoritative registry подтверждает `pending: []`. Следующий безопасный шаг — read-only сопоставление local identity key с approved `openclaw-macos` record и проверка app remote handshake после refresh; не пересоздавать identity и не ротировать token. Если приложение позже покажет конкретный pairing prompt, одобрять только соответствующее ожидаемое устройство.

The Companion app uses an app-owned SSH tunnel to the local WSL Gateway (`ws://127.0.0.1:18789`), so its acceptance owner is the local WSL registry. That registry reports an approved `openclaw-macos` UI record connected with no pending approval; the public TLS registry's disconnected Mac UI records are a separate Gateway owner. CUA shows the app page, sessions, and Workboard surface without a reconnecting banner.

Приёмка: приложение перестаёт показывать reconnecting, видны sessions/Workboard, authenticated control channel отвечает; затем отдельно разрешённый harmless control ping. Rollback: quit app и восстановить `/tmp/hicks-companion-before-20260906/openclaw.sqlite` и `openclaw.json` backup.

## C. Windows node/browser self-recovery

### Уже исправлено и доказано

В `C:\Users\clawadmin\.openclaw\openclaw-node-service-20260828.ps1` устранён self-port gate: прежний `Test-GatewayPort` проверял node listener `127.0.0.1:18789` и блокировал recovery. После ремонта controlled node stop вызвал relaunch примерно за 8 секунд. В `node.cmd` восстановлен существующий canonical TLS route `myhajick238.duckdns.org:18790`; token не менялся. Backup: `C:\Users\clawadmin\.openclaw\node.cmd.pre-route-repair-20260906`; source backup и fixed script лежат в `/tmp/hicks-before-20260906/`.

Fresh authoritative public Gateway proof: node registry показывает Windows Headless identity paired/approved/connected; routed `system.which` вернул Windows portable Node; browser proxy для `icloud` показал `running=true`, `cdpReady=true`, `pageReady=true`, Edge CDP `18801`, `/tabs` — существующую `Фото iCloud`, `/snapshot` — authenticated Photos UI с Apple ID, альбомами и media navigation. Это подтверждает текущий маршрут, но не новую induced recovery после Gateway restart.

### Следующая проверка

Не менять node id, token, VLESS route или photos. На authoritative public Gateway повторить bounded node stop/relaunch, затем проверить registry connected, routed exec marker, browser `status`, `tabs`, snapshot. Текущий статус: connected/routed/browser = PASS; induced end-to-end recovery после этого audit = UNKNOWN (локальный process relaunch после controlled drop уже доказан ранее). Для self-healing acceptance нужен наблюдаемый drop/restart с автоматическим возвратом node и browser route без Codex/manual pairing. Если identity снова stale, владелец — Windows Task Scheduler/node owner и authoritative Gateway registry; не создавать второй scheduler.

## Почему inline-задача Hicks застряла

Есть прямое Telegram-свидетельство: Hicks сообщил, что Windows-нода отвечает, но команда ушла в неподходящий shell и не выполнилась; затем остановился на рекомендации повторить через корректный shell-маршрут. Это подтверждает reachable node при неверном execution context и отсутствие автоматического owner-level retry. Inline capability при этом оставалась не включённой/не подтверждённой.

Требование для общего repair owner: перед dispatch определить shell capability и structured exec target (Windows PowerShell/cmd против WSL через абсолютный `C:\Windows\System32\wsl.exe -d Ubuntu-24.04`), один раз повторить у владельца после классифицированного shell mismatch, сохранить видимый terminal marker/output и не объявлять completion по одному факту reachability. Приватный bot handle из свидетельства в artifact не включается.

Полного локального transcript/tool trace нет, поэтому нельзя утверждать более глубокую причину, чем подтверждённый shell mismatch и остановка вместо retry. `Message/chat_id/message_id` остаются несовместимыми с inline query; fabricated Message, global runtime store или Codex subagent были бы неверными обходами.

## Общие proof gaps

- Telegram A/B native subagent overlap, prompt C responsiveness, targeted cancel и exactly-once delivery ещё не прошли live Telegram-visible proof.
- Companion pairing/control ping не завершены: current UI reconnecting.
- Windows process recovery доказана локально после controlled drop, но повторная end-to-end recovery с authoritative Gateway и browser после restart ещё не доказана.

## Финальный verification gate — обязательный шаг Luna

После любой реализации Luna обязана на exact current head выполнить и записать в WORKLOG: source/tests/build; live Telegram inline query в другом чате с ровно одной article и native OpenClaw trace; normal Telegram DM regression; Companion authenticated control ping с sessions/Workboard; Windows induced node stop → auto-relaunch → authoritative registry connected → routed exec → iCloud status/tabs/snapshot; проверку сохранности proxy/VLESS route; rollback readiness и measured before/after. Пока любой lane имеет `UNKNOWN` или blocker, итог помечается `PARTIAL`, без completion claim.

### Inline implementation status

Source implementation now exists behind the core-owned `channelRuntime.externalTurns.runResultOnly` capability. The canonical embedded runner remains the only execution owner; Telegram does not fabricate a `Message`, create a second scheduler, or deliver a normal chat reply. The adapter is fail-closed when the capability is unavailable or the configured numeric DM allowlist rejects the sender, deduplicates query IDs, and answers each accepted query exactly once. Focused source tests pass; live BotFather `/setinline`, live model-backed inline query, normal DM regression, and exact-head build remain open verification gates.

### Luna live deployment checkpoint

Exact-head source gates passed: focused Vitest 4 files/38 tests, oxlint, diff-check, core and extension typechecks, and build. The loaded remote dist was backed up before an atomic replacement; the owner system unit was restarted without changing config, secrets, proxy/VLESS routes, or SQLite state. Gateway logged `ready`; Telegram polling is `connected`, `probe.ok=true`, and reports `supportsInlineQueries=true`. The system unit remained in `activating (start-post)` during the bounded observation, and a pre-existing optional Matrix doctor-contract dependency warning was logged, so service-manager ACTIVE is not accepted.

Authoritative public Gateway read-only status after restart shows paired Mac and Windows nodes connected, and Windows `nodes invoke system.which` reaches the node. The requested browser proxy paths returned 404 in this fresh probe, so current iCloud status/tabs/snapshot is UNKNOWN and no browser mutation occurred. Telegram user-visible inline and normal-DM proof is also UNKNOWN because no Telegram user-client/e2e credential was available in this lane; BotFather was not changed. Overall lane remains PARTIAL until the mandatory final verification gate passes.

The 30-probe soak lasted approximately 35 minutes. Gateway stayed active and the iCloud profile stayed ready on all non-SSH samples. Four isolated node-false snapshots were immediately contradicted by fresh authoritative status queries showing Windows Headless connected; one SSH banner timeout was transient. After a Gateway restart, the node remained paired/connected, and a second controlled node stop produced a new owner PID within about 10 seconds without duplication, followed by connected registry and iCloud status/tabs proof. No sustained outage was observed.

### Lead-reported Windows/Companion state awaiting Luna verification

Lead reports a supervisor matcher repair keyed to the owned portable-node command, induced PID recovery in approximately 12 seconds, and a running task. Lead also reports Companion recovery through the existing SSH transport after a direct-WSS TLS hostname mismatch, STRICT rebuild of the native empty identity tables with backups/integrity checks, removal of a stale tunnel LaunchAgent, and a connected UI after relaunch. These are recorded as handoff evidence, not final acceptance; Luna must independently recheck the exact current state and preserve the final gate above.

## 2026-09-06 fresh Windows uptime audit

Read-only Windows evidence: `node-service.log` shows owner starts on 2026-09-06 02:47, duplicate termination and owner failure, then launches at 02:48, 02:49 and 02:53. The current Windows portable-node process started at 02:53:51 and was still running during the probe; Task Scheduler reports last result `0x800710e0` and no missed runs. The authoritative Gateway last connected the node at 03:04:14. This is a post-repair observation of recovery churn followed by a currently stable process, not a statistically valid 30% uptime calculation; pre-repair logs are sparse and cannot yield a denominator.

Failure ranking: (1) confirmed pre-repair self-port gate/self-loop route, fixed with high confidence; (2) confirmed early post-repair duplicate/owner failure and repeated launch churn, medium confidence as an unresolved lifecycle symptom; (3) current stable node/browser route, confirmed by authoritative registry and routed probes; (4) network/TLS/proxy instability, unproven in this bounded audit because no fresh transport error log was available. Acceptance threshold: at least 30 minutes continuous authoritative connected state plus one induced stop→automatic relaunch cycle, followed by registry, routed exec and browser proof; repeat once after a Gateway/process restart before calling self-healing complete.
