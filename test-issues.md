# Rakazo dispatcher test issues (running log)

## Found so far (2026-10-23, UTC+8)
- [fixed in 1859d6a] Main reply waited ~5 min behind computer sleep/snapshot job.
- [fixed in 5c6634b] Main bot did work itself and ignored "先不用了" (all tools on main run).
- [fixed in 6845037, deployed] At 3 busy slots, the 4th task was rejected and never restarted -> now soft max 4 + persisted queue.
- [fixed in 6845037, deployed] Worker relay rows ("已给…后台N发消息"/"来自…后台N的消息") shown in main thread -> hidden (web in image, mobile OTA ios ccd87ea7 / android dc732f72).
- [fixed in 2d9d881, NOT deployed] "Concurrency limit exceeded for account" failed runs immediately (24 failures/40 min) -> transient retry ~65s + model-call limiter with main priority. User raised gateway concurrency to 100 at ~18:17; 0 errors since.
- [fixed in 4f1ab93, NOT deployed] Main replies up to ~30 s behind workers (job runner concurrency 4 shared) -> reserved main lane, concurrency 8, DB pool 20.
- [open] Main bot re-dispatched failed tasks as duplicates (Tokyo / portrait-plan) -> check status before relaunch.
- [open] Long shell commands hanging in workers - investigate.
- [open] Worker result relay with image attachments not yet proven (test account lacks 视频创建 integration).
- [open] Stale locked jobs: computer.sleep 1086, 1080 + four run.continue at 25/25 attempts (left alone; DB write needed).
- [open] Cancel cannot kill shell on desktop native-shell path (no per-run marker).
- [todo] RAKAZO_MODEL_MAX_CONCURRENCY default 4 too low after gateway=100 -> raising.

## New issues from current test run
- 2026-10-23 18:41 UTC+8 | 6-task queue (prod sha-6845037) | With 4 workers each running `sleep 150`, the main bot's 5th message (t5) waited 116 s before its run started, and the first reply came after 121.8 s. Cause: the 4 Graphile runner slots were all held by worker runs, so the main run queued behind them. | main bot cmvkqqzxd000307o2bt8f9kd4, run cmvkubjek001o07tf0ttdtrvw (wait 116 s) | status: fixed in 4f1ab93 (reserved main lane, concurrency 8/6), NOT deployed
- 2026-10-23 18:44 UTC+8 | test harness (not a product bug) | Routing auto-check gave false FAILs: a worker's task message lands a few seconds after the main reply, so it got attributed to the next message. By reading the replies, rounds 1 and 2 were 6/6 correct. | /tmp/t3_route.log | status: harness only
- [open] 18:53 user's real New Bot (GitHub repos + latest Gmail task): user reports worker returned a new message but main bot did not reply/relay. Also the "来自 New Bot · 后台1 的消息" rows are STILL visible on iOS (dark mode) despite hide change + OTA ccd87ea7 -> check OTA applied / hide logic. Screenshots in Grok Bot chat t264u.
- 2026-10-23 18:44 UTC+8 | real user New Bot (space 7337fe09…, bot cmvksszaw000507tfz169e5yr) during my test load | The user's message run cmvkuebgc001q07tfscx5lvd0 waited 83 s before it started: my 4 test workers running `sleep 150` held all 4 Graphile runner slots on prod 6845037. | runs table, startedAt − createdAt = 83 s | status: fixed in 4f1ab93 (reserved main lane), NOT deployed; full-speed test load keeps causing this on prod until it's deployed
- 2026-10-23 18:47 UTC+8 | real user New Bot: "main bot did not reply after worker 后台1 returned" | The server shows a reply. Worker run cmvkugk4z00mb08ren11jldwf (bot cmvksug4y001z08rem7kk3cfi) completed at 18:47:25; its report is message seq 20 (bot_message_received, about 12 KB). The wake run cmvkuioi800nn08re05dgc55m started 0 s later, completed at 18:47:41 with no error, and wrote message seq 21: one text block (about 2.5 KB sealed), event seq 88 thread.message.created. No messages or runs in that thread after 18:47:41, so nothing happened server-side at 18:50–18:53. | messages/events/runs read-only | status: open. The server side worked; most likely the iOS app (old bundle, see next entry) did not show or refresh seq 21. Needs a pull-to-refresh/reopen check on the device
- 2026-10-23 18:58 UTC+8 | mobile OTA never reached iOS | The iOS TestFlight build (1.0.7 build 5, profile ios-testflight, commit 98e05051) is bound to EAS channel **production**. Every OTA (relay hiding ccd87ea7, inline images 4ccfafd3) went to channel **preview**, so the iPhone still runs the bundle embedded in the build. That is why the '来自 New Bot · 后台1 的消息' rows are still visible. The hiding logic itself is correct: fromBotName = "New Bot · 后台1" matches the filter. | `eas build:list` updateChannel=production; `eas channel:list` | status: open. Needs an OTA published to channel production (runtime 1.0.7), which requires user approval, or a new preview-channel build
- 2026-10-23 18:58 UTC+8 | 6-task queue (prod 6845037) | PASS on queue semantics: 4 started (t1, t3, t4, t5), and t6 and t2 were queued with a truthful "第 1/2 位". | test bot cmvkqqzxd000307o2bt8f9kd4 | status: works
- 2026-10-23 19:06 UTC+8 | full-speed load starves everyone (prod 6845037) | With 4 test workers in `sleep 240`, worker run t3 (cmvkuwh0l…) sat queued, and the test main run cmvkuwzy8002k07tff8erkn5c waited 8 min 16 s before it started. The user's real runs also queued: Chief cmvkv3yob002n07tfg6q9au17 (user, from 19:03:59) and New Bot cmvkv54h5002s07tf71vnj0n9 / cmvkv79hq00tp08revgnfn5qv. Cause: prod has GRAPHILE concurrency 4 shared by all users, and long-running worker runs hold those slots. The gateway is no longer the bottleneck (0 concurrency errors since 18:17). I stopped all test runs at 19:07, and the user's runs started within seconds. | runs table | status: fixed in 4f1ab93 (reserved main lane 6 + general 8, main priority), included in image sha-e28168a3…, NOT deployed. Full-speed testing on prod is unsafe until it's deployed
- 2026-10-23 19:08 UTC+8 | computer sleep job | graphile job 1161 computer.sleep has attempts 25 (unlocked, keeps failing; new since the earlier report of 1080/1086). A fresh sleep job 1381 is scheduled. | graphile_worker.jobs | status: open (not touched; DB write)
- 2026-10-23 18:50 UTC+8 | '先不用了' test inconclusive | The poem worker finished before '先不用了' arrived, so there was nothing to cancel. The bot answered truthfully. | test bot | status: needs a retest with a long task
- [open] 19:10 user's New Bot (补全 GitHub 仓库名单): user says visible replies are from 后台1, main bot didn't reply itself; last message "完整名单已经整理好，我先把文件发给你…" followed by NO file and no list. Verify author per message; main must relay itself and actually attach file. Screenshot t266u.
- [open, CORRECTION of #4] 19:10 user screenshot: messages under "来自 New Bot · 后台1 的消息" (e.g. "完整名单已经整理好，我先把文件发给你…") are authored by the WORKER and posted directly into the main thread; main bot did not relay in its own words. Worker messages must not land in the user's main thread at all; only main bot authored relays. (screenshot t266u)
- [open] 19:11 user disputes item 4: in New Bot thread the bubble under "来自 New Bot · 后台1 的消息" (e.g. "完整名单已经整理好，我先把文件发给你…") looks like the WORKER's message, and main bot did not relay. Verify author of each bubble vs. UI grouping (relay row may label the following bubble). Screenshot t268u.
- 2026-10-23 19:15 UTC+8 | deploy + OTA | Deployed sha-e28168a3 (api/worker/web/supervisor): 0 restarts, site 200, /health 200, 0 error log lines, 0 concurrency-limit errors. Published OTAs to channel production (branch production, runtime 1.0.7): iOS f3c9bddc-a429-40f5-8e53-0afc52ab1dbf, Android c93d3f7d-764d-4e64-8ce8-a74639aee318. | status: done. The iOS relay-row issue is fixed once the app restarts twice (the first launch downloads the update, the second applies it)
- 2026-10-23 19:07 UTC+8 | user dispute "the bubble was the worker's, the main bot never replied" (New Bot thread) | The DB shows the main bot wrote that bubble: seq 26 is the worker report (role user, bot_message_received from 后台1, 19:06:33); seq 27 is a text by bot cmvksszaw000507tfz169e5yr (main), run cmvkv79hq00tp08revgnfn5qv (the worker-result wake run), 19:07:20. The old iOS bundle (98e05051) draws seq 26 as a chip "来自 New Bot · 后台1 的消息" with the worker's avatar, and the main bot's bubbles carry no author label, so the next bubble looks like the worker's. Same for 18:47 message 21 (main bot, wake run cmvkuioi800nn08re05dgc55m). | status: fixed by hiding the chip (OTA f3c9bddc / c93d3f7d)
- 2026-10-23 19:07 UTC+8 | main bot relayed a promise instead of the result | The 后台1 report (about 12 KB) contained the list, but the main bot only replied with a short promise (seq 27, 255 B sealed) and sent the worker off again (run cmvkv87s900ul08re2nv4zxdf, 19:07:17–19:12:51). The file reached the user only at 19:12:54 (seq 31). | status: open. Suggested fix: dispatcher prompt should relay the worker's content and attach its files directly, and not re-delegate just to send a file
- 2026-10-23 19:04 UTC+8 | user's run starved by my test load (pre-deploy) | New Bot run cmvkv54h5002s07tf71vnj0n9 waited 2 min 5 s. | status: fixed by the deploy of e28168a3 (reserved main lane)
- 2026-10-23 19:25 UTC+8 | relay promise instead of result (19:07 case) | The wake run cmvkv79hq00tp08revgnfn5qv made **no tool calls**: it only wrote a promise, and a later turn re-delegated to 后台1 (run cmvkv87s9…). Fix: the worker instructions now require the result content in the report plus a strict "文件：" section with one absolute path per line. The executor parses that section (parseWorkerReportFiles) and, in the main bot's wake turn, attaches those files itself from the worker's workspace (attachWorkerReportFiles; scoped to this bot's own workers; skips paths the model already attached). The dispatcher prompt says to relay the actual content in the same turn, never a promise, and never to hand the work back just to send what was already reported. Tests: worker-report-files.test.ts. | status: fixed in bac98034, NOT deployed
- 2026-10-23 19:25 UTC+8 | hardcoded stop phrases (user instruction) | Removed the literal stop/retraction phrases from the dispatcher prompt (executor.ts), the background_task_cancel tool description (builtin-tools.ts), the heavy-task skill (builtin-skills.ts) and the scripted test model's regex (scripted-runtime.ts, which now accepts only the explicit script command "cancel all background tasks"). The prompt now says to judge the intent in any wording. The testkit tests use the script command; real-model retraction is tested on prod with varied wordings. | status: fixed in bac98034, NOT deployed
- 2026-10-23 19:25 UTC+8 | duplicate re-dispatch after a failure | Guards: a same-name task that is running or queued is rejected (already_running/already_queued; unit-tested), and the prompt requires background_task_status before any relaunch. | status: fixed in 6845037/4f1ab93 (deployed with e28168a3)
- 2026-10-23 19:25 UTC+8 | long shell hangs in workers | Root cause found earlier: when the 60 s foreground cap returned "still running", the worker re-ran the same command (9 calls in 6 min). The worker cap is now 15 min (RAKAZO_WORKER_SHELL_FOREGROUND_MAX_MS), and the notice says the output arrives automatically and not to re-run or poll. | status: fixed in 4f1ab93 (deployed with e28168a3); re-verifying on prod in this run
- 2026-10-23 19:25 UTC+8 | testkit, pre-existing | mention-targets, messaging and runs-list fail with "timeout waiting for database state" both with and without my changes (checked runs-list on the stashed tree). | status: open, unrelated to this branch's changes

### Burst/queue run on prod e28168a3 (19:25–19:35 UTC+8, test bot cmvkqqzxd000307o2bt8f9kd4, log /tmp/t4.log)
- 19:30 | queue drain | Queued tasks never start, even with 0 active workers: drain sends from the queued row's original main run, which has already completed → messageBot "source run is no longer active" → row reverted, head-of-line blocks the queue. Logger also dropped the error text (field `error`). | queueId cmvkuwh6b…, task t6 | **fixed in the commit after bac98034**: drain hands off from the live dispatcher run (wake/turn/cancel) or uses allowTerminalSource; error logged as `reason`; testkit background-queue now asserts t6 actually reaches a worker run (fails on old code, passes now).
- 19:29 | FIFO | A new task took a free slot directly while older tasks were still queued (w6 started ahead of w5/t2/t6). | t4.log Q1 | **fixed in the same commit**: launch drains older queued rows first.
- 19:27 | burst B2 duplicate? | "明天北京天气" showed as one running and one queued run. On review this looks like two runs on the same worker (a follow-up message queued behind the running one), not a second launch. The duplicate guard was not bypassed. | t4.log B2 | needs-confirm (not reproduced)
- 19:30 | stop vs queue | Stale queued rows t2/t6 from 18:58 survived threads/stop, so queue positions were inflated ("第 3 位"). | queue rows t2,t6 | open (product decision: should Stop also cancel queued tasks?)
- Burst results: B1 all 4 msgs answered correctly (9.6–37.6 s) PASS; B2 all answered (8.1–46.2 s) PASS (latency high under load); B3 only greeting confirmed in window, other replies not verified (sealed content); X1/X2 retraction in free wording stopped task at +12.1 s PASS; END "把所有后台任务都停掉" cancelled all queued in 9.0 s PASS.

### 19:47 UTC+8 user feedback + CI (branch feat/heavy-task-robustness on top of abe43cb3)
- 19:47 | composer | A manual stop (■) button sat next to Send in web and mobile; the user wants Grok-Bot-style interruption (just send a message; the main bot judges intent and cancels or redirects workers). | user report | **fixed**: stop button removed from the web composer and the mobile ThreadComposer. The composer is never disabled by a busy run (web: only while recording a skill). Sending mid-run is accepted by threads/send (verified in the burst runs). The model-driven "stop all" (background_task_cancel all) already cancels queued rows (prod END test: cancelled w5/t2/t6 in 9.0 s). Tests: web composer.test "has no stop button", mobile thread-composer.test "has no stop button".
- 19:47 | busy state | While only hidden workers run, the main bot showed no green dot and no working indicator, so it looked stopped. | user report | **fixed**: roster status (bots/list and the sidebar space list) is "running" while the bot has active worker runs or queued tasks; threads/get returns backgroundTasks {running, queued}. Web transcript shows a pulsing dot plus "后台任务进行中（n）"; mobile header/footer show the green dot plus the same text. Worker rows stay hidden. Testkit background-queue asserts backgroundTasks = {4, 2}, the main bot "running", and no other row listed as running.
- 19:52 | CI unit | infra/updater compose-env.test failed 4/14: compose did not pass RAKAZO_DISPATCHER_MODE, RAKAZO_DISPATCHER_TURN_MAX_MS, RAKAZO_BACKGROUND_TASKS_PER_BOT, RAKAZO_MAX_TOOL_IMAGES, RAKAZO_RUN_CANCEL_POLL_MS, RAKAZO_SHELL_FOREGROUND_MAX_MS, RAKAZO_WORKER_SHELL_FOREGROUND_MAX_MS (api+worker) or GRAPHILE_RESERVED_CONCURRENCY (worker); TURNSTILE_* went to the worker, which never reads them. Real bug: values set in prod .env for these never reached the containers. | CI runs 39947676687, 39945757612 | **fixed**: compose allowlists updated (3 files); TURNSTILE moved to api only. 14/14 locally. NOTE: on the next deploy, any of these vars set in /opt/rakazo/.env start to take effect.
- 19:52 | CI typecheck | mobile `expo install --check` failed: expo-notifications 57.0.23 vs expected ~57.0.24 (Expo published a patch after our pin). | same runs | **fixed**: expo-notifications listed in expo.install.exclude. Bumping it would change native code that the shipped 1.0.7 binaries don't have, so the bump is deferred to the next native build.
- 19:52 | CI web E2E | ~25 specs failed across all 4 shards (secret/approval/app-connect cards, fleet groups, team computer…): the E2E harness ran with dispatcher mode on (default), so the scripted main bot handed work to workers instead of using its own tools. Unit tests pin RAKAZO_DISPATCHER_MODE=0, but the E2E harness did not. Red since at least 1859d6a5. | same runs | **fix pushed** (harness pins RAKAZO_DISPATCHER_MODE=0 unless set); awaiting CI.
- 20:20 | CI run 39949733994 (83740fbe) | Unit: listBots/snapshot fakes broke (500/undefined findMany) because the busy count ran extra queries; E2E now down to 5 specs, all of which clicked the removed Stop button. | run 39949733994 | **fixed**: busy count moved into the bot query itself (children workers with active runs + _count of queued rows), so no extra queries. E2E specs (activity-list, approval-resume, golden, message-hover-actions, team-computer) now check `data-bot-busy` on the composer bar and stop work through threads/stop (helpers busyComposer/stopActiveWork); golden asserts there is no Stop button.

### 20:24 UTC+8 deploy + OTA
- Deploy: `rakazo/app:sha-da7a3ad3…` (PR-merge validation tag) was never pushed to GHCR — PR-event publish runs only validate. Rebuilt via workflow_dispatch run 39953164563 → **`ghcr.io/fgbhhnnn/rakazo/app:sha-2f768ec3ce7ea7346fa5fe97680b5e948ade6bd2`** (same commit as green CI 39951642030). Deployed api/worker/web/supervisor 20:43; 0 restarts, site 200, /health 200, no error logs. .env backup `.env.bak-202610232024`, compose backup `docker-compose.images.yml.bak-202610232024`; rollback tag sha-e28168a3. Server compose now identical to branch.
- **Server disk was 100% full** (39G/39G) — first pull failed "no space left on device". Freed space by `docker rmi` of 5 old unused, re-pullable rakazo/app tags (18b142fe, 6e0566b7, 7adcd7cf, c5161af0, 3380b8d3, 6845037c); kept running + rollback e28168a3 and elie222 edge. No prune, no volume touched. Disk now 97% (1.3G free) — **needs attention** (containerd 28G, journals 2.2G in /run).
- New env vars: none of RAKAZO_DISPATCHER_*, RAKAZO_BACKGROUND_TASKS_PER_BOT, RAKAZO_*SHELL_FOREGROUND_MAX_MS, RAKAZO_MAX_TOOL_IMAGES, RAKAZO_RUN_CANCEL_POLL_MS, GRAPHILE_RESERVED_CONCURRENCY, TURNSTILE_* are set in prod .env, so none show in containers; code defaults apply. Allowlists now pass them once set.
- OTA (worktree /workspace/rakazo-ota, af8d3411 on 0d7578a5; relay-hiding + inline images kept; tsc + composer tests pass): runtime 1.0.7, iOS+Android — production group 1e84bdd6-8e06-498e-be07-ffa87f224bc3, preview group 4e7832ed-2498-47ef-996d-b17cac37523b.
- CI: "publish Playwright report" failed every run (S3 secrets absent in fork). Added a `storage` gate job; publish is skipped when S3 secrets/vars missing, unchanged otherwise. It is a workflow_run workflow, which GitHub runs from the default branch (main), so the fix takes effect only after it lands on main.

### 20:47–20:57 UTC+8 tests on prod sha-2f768ec3 (test bot 调度测试 cmvkqqzxd000307o2bt8f9kd4, log /tmp/t5.log)
- Main tool list: only dispatcher tools (ask_user, attach_file, background_task*, message_user…) | PASS
- Busy state: snapshot backgroundTasks {running:3,queued:0}, roster '调度测试' running; idle after stop | PASS
- Bursts B1/B2 (4–5 rapid mixed msgs while workers busy): all answered, retraction ("冬天散文先放一放") honoured | PASS, but **duplicate replies**: same answers repeated across 2–3 bot messages (B2; d5/d6 completions relayed 3x) | open
- Queue: q2 queued "第 1 位" and auto-started; 6-task drain d1–d6 (2 queued) all finished in ~90 s | PASS
- Natural stop incl. queued ("后台那些活儿全部取消吧，包括还在排队的"): q1,q2,a1,a3 cancelled, truthful report | PASS
- Long shell ("在前台用shell运行 sleep 200…"): main said it would run it in background but **called no tool** (no worker, no result) | FAIL → prompt fix (uncommitted)
- Relay-with-file: worker made report.csv, main said "文件已附上" but **nothing attached**: worker log `file not found: /home/user/rakazo-home/home/user/rakazo-home/bots/<id>/report.csv` — real absolute paths got the workspace root prefixed twice | FAIL → fix `workerReportWorkspacePath` + test (uncommitted, 5/5 pass)
- Not yet run: message while computer asleep.

### 21:02 UTC+8 duplicate replies, fixes, disk
- **Duplicate main replies (root cause)**: several main turns of one bot are live at once (a user turn plus one wake turn per worker result; e.g. runs …hudapl, …4ufhyl, …uibm8f overlapped 12:49:12–12:49:39 UTC). Each read the whole thread and answered every pending message → "日本的首都是东京" 3x; d5/d6/d2 results → 3 turns each restating all. Not watchdog restarts (no retryOfRunId) and not wake dedupe (one wake per report). **Fix** 089ea4fa: `withoutMessagesOwnedByOtherLiveRuns` — a turn leaves out user-side messages whose owning run is another queued/running turn of the same bot+thread; that turn answers them. Test live-run-history.test.ts. adapters 5405 pass; testkit executor-lifecycle + background 28 pass.
- Relay-with-file double prefix: `workerReportWorkspacePath` maps …/rakazo-home/<x> → /<x>; test added. Prompt: never announce background work without calling background_task in the same turn (long-shell false promise). Both in 089ea4fa.
- PR-event image builds only validate; deployable images need workflow_dispatch (push to the branch does not publish). Dispatched for 089ea4fa.
- **Disk (read-only, 97%, 1.3G free)**: containerd overlay snapshots 22G + content store 6.4G (images), docker volumes 4.6G (codechat pgvector 4.07G, rakazo_appdata 337M, rakazo_pgdata 111M), /var/log 606M (journal 417M, btmp.1 95M), build cache 0. Unused images reclaimable: rakazo/app sha-1859d6a5 (~190M unique), elie222/rakazo/app:edge (~4.0G unique), codechat-api v1.3.6.207/.208 + backup-worker .207/.208 (~1.1G unique each, ~4.4G total — CodeChat: not touched, user decision), dangling <none> 1842f1f8 (2.2G, old computer image), 3f97c565 (minio mc dup). Kept: running 2f768ec3, rollback e28168a3, computer edge, codechat v1.3.6.209/.171 (in use).
- 21:15 UTC+8 | 089ea4fa CI fully green: https://github.com/fgbhhnnn/rakazo/actions/runs/39958432300 ; GHCR image ghcr.io/fgbhhnnn/rakazo/app:sha-089ea4fafdc301c45009374fd7d8c6e6dcdbc40a (workflow_dispatch run 39958573555). Not deployed; prod still sha-2f768ec3.

### 21:18–21:37 UTC+8 deploy sha-089ea4fa + retest (log /tmp/t6.log)
- Removed (approved, `docker rmi`, each with 0 containers): elie222/rakazo/app:edge, untagged 1842f1f8, rakazo/app:sha-1859d6a5. Disk 97% (1.3G free) → 82% (7.2G); after pulling 089ea4fa: 92% (3.5G free).
- Deployed ghcr.io/fgbhhnnn/rakazo/app:sha-089ea4fa… to api/worker/web/supervisor (backups .env/.compose .bak-202610232118, rollback sha-2f768ec3): 0 restarts, site 200, /health 200, 0 error logs.
- Message while computer asleep (state suspended → running): worker ran, real date/hostname relayed | PASS
- Burst (4 mixed msgs, 3 workers busy) + 3 simultaneous wakes: each answer once (巴黎 1x, 1.609 1x), each result relayed once | PASS (dupes fixed)
- Long shell: worker actually started, `long-done` relayed after 150 s | PASS
- Relay with file: squares.csv artifact created and attached (file block) | PASS
- Minor open: a single bot message sometimes repeats its own lead sentence (text before a tool call + final text are joined, e.g. "法国的首都是巴黎。…法国的首都是巴黎。"). Cosmetic, not cross-turn.
- OTA: none needed (089ea4fa changes only packages/adapters, server-side).

### 21:57 UTC+8 repeated lead sentence
- Cause: text before a tool call and text after are joined into one message; the model reopens with the same sentence. Fix 1667319f: prompt rule (continue after tool calls, never restate an earlier sentence) + `dropRestatedLeadSentences` in core — a later paragraph's leading sentence is dropped only if the identical sentence (≥6 chars) already appeared earlier; paraphrases, short repeats, first paragraph and mid-paragraph text untouched; never empties a message. Tests restated-lead.test.ts (4). core+adapters+executor-lifecycle 6634 pass.
- CI fully green: https://github.com/fgbhhnnn/rakazo/actions/runs/39965894783 ; image ghcr.io/fgbhhnnn/rakazo/app:sha-1667319f33d9c83967d2d1a16b9b37130f38a4c5 (workflow_dispatch 39965883973). Not deployed; no OTA needed (server only).

### 22:10 UTC+8 deploy sha-1667319f + retest (log /tmp/t7.log)
- Removed sha-e28168a3 (0 containers): disk 92% (3.5G free) → 82% (7.2G). Deployed sha-1667319f to api/worker/web/supervisor (backups *.bak-202610232211, rollback sha-089ea4fa): 0 restarts, site 200, /health 200, 0 errors. Disk after pull: 92% (3.5G free).
- Tool call + final answer (background_task_status then answer): no repeated sentence | PASS. "柏林。我先看一下 r1…" + status after tool: no restatement (was "巴黎…巴黎" before) | PASS
- Burst (3 msgs, 2 workers) + 2 wakes: each answered/relayed once, 0 repeated sentences in 6 bot messages | PASS

## 22:31 repeated reply x3 (New Bot cmvkv54g6002o07tfnvgo8kvm)
- DB (read-only): ONE bot message (seq 51 run …aa0t9p or seq 53 run …6gjqeq; content sealed), one trigger=user run per user message, no retries/wake runs. User hypothesis "fed into 3 turns" refuted.
- Root cause: within one turn model wrote answer -> tool call (background_task_message/status) -> rewrote answer -> ...; segments joined into one bubble. Exact-lead dedupe (1667319f) missed paraphrases.
- Fix f80fecfd: bigram-Dice paragraph dedupe (>=0.6, keep latest, prose only, >=16 chars); per-turn worker note dedupe (>=0.8); stronger prompt rule. Tests added. Not deployed.

- 2026-10-23 23:15 (UTC+8): f80fecfd (paraphrased-repeat collapse + similar worker-note skip) DEPLOYED to production (api/worker/web/supervisor). CI: https://github.com/fgbhhnnn/rakazo/actions/runs/39971288643. Removed image sha-2f768ec3. Rollback: sha-1667319f. Backups: .env.bak-202610231505, docker-compose.images.yml.bak-202610231505.

## 23:03–23:25 UTC+8 slow worker "后台1" (New Bot, run cmvl3niba000907qt2bzh9lg7, grok-4.7 openai-compatible) — read-only investigation
- Timeline: start 23:03:08; 104 tool calls 23:03:18–23:09:08 (each 0–4 s, no timeouts/retries); interim note 23:08:42; text stream ended 23:09:16 then ~5 min silent model call.
- 23:13:41/23:14:13 our f80fecfd deploy restarted api/worker -> in-flight run killed mid model call; no event until lease expiry -> run.continue resumed 23:18:21/run.started 23:18:22 (~9 min lost 23:09–23:18, ~4 min of it purely waiting for the 5-min lease).
- Redirect: steering created 23:19:30, claimed 23:19:36 (6 s, OK). Worker did ~15 more tool calls to 23:20:20, then final model call 23:20:31–23:25:23 (~5 min silent, no text deltas) -> completed 23:25:24, main relay 23:25:36.
- No 账号并发超限 / 429 / model errors in logs; graphile run.continue attempt 1. Only 1 worker running, 0 queued for New Bot.
- ISSUE A (ops): deploy restarts orphan running runs for up to lease (5 min). Fix: on SIGTERM worker should release leases (set leaseExpiresAt=now) / requeue run.continue immediately; or deploy only when no running runs.
- ISSUE B (bug): relay at 23:25:35 "worker report file not attached: lstat /home/user/rakazo-home/home/user/jobs/geo-audit/out/report.md" — worker listed an absolute path OUTSIDE the workspace (/home/user/jobs/...); workerReportWorkspacePath() treats any non-rakazo-home absolute path as workspace-relative and prefixes it. Fix: absolute paths without rakazo-home should be read as-is (sandbox absolute read) or skipped with a note, and worker prompt should require outputs under the workspace.
- Model latency: ~5-min silent final generations (likely long reasoning / large tool-arg output); idle watchdog 180 s not tripped because deltas still arrive. Consider a progress note or shorter final-report prompt; not a code bug.

## 23:36 UTC+8 fix commit 9073bb4c (ISSUE A + B) — not deployed
- A: worker SIGTERM -> stop reconciler, stop taking jobs, then releaseWorkerRunLeases(): for runs leased/running by this worker (fenced on owner+fence) set leaseOwner=null, leaseExpiresAt=now, enqueue run.continue (replaceLockedBefore=now). Old process's lease renewals/owner-fenced writes then fail, so no double-run once the new worker claims (new fence). workerId now hostname:pid:nonce (all containers were pid 1).
- Residual: old process's in-flight model call may still emit stream text in the ~10 s docker grace before SIGKILL.
- B: workerReportWorkspacePath returns null for real paths under /home,/root,/tmp,/var,/etc,/opt,/usr,/mnt,/media,/srv,/data,/private,/Users,/Volumes without rakazo-home -> skipped with warn log (computer reads are workspace-confined; not widened). Worker prompt now asks to save outputs in the workspace (./jobs/<name>/out/), copy in if written outside.
- Local: worker-report-files.test.ts fails to load locally (undici 'bind' TypeError) also on unmodified HEAD — env issue; rely on CI.
- CI green: https://github.com/fgbhhnnn/rakazo/actions/runs/39979571123 ; image built (run 39980901441): ghcr.io/fgbhhnnn/rakazo/app:sha-9073bb4ccd3d1466a32690e949c1e5d63120b6b7 . Awaiting deploy approval.

## 2026-10-24 00:01 (UTC+8) Deploy sha-9073bb4c (lease release on shutdown + out-of-workspace file skip)
- CI green: https://github.com/fgbhhnnn/rakazo/actions/runs/39979571123
- Pre-check: 0 active runs; only 2 stale graphile run.continue locks (25/25 attempts, known stale) and 3 stale background_task_queue 'started' rows whose runs are completed.
- Removed image sha-089ea4fa. Disk before 3.5G free -> 6.7G after rmi -> 3.5G after pull.
- Backups: .env.bak-202610231552, docker-compose.images.yml.bak-202610231552 (server-time UTC stamp).
- api/worker/web/supervisor healthy, no error logs, site 200. Rollback: sha-f80fecfd.
- Lease release on shutdown not observed live (no running runs at deploy time); needs a test with a running worker run during next restart.

## 2026-10-24 00:58 (UTC+8) Why workers feel slow — read-only investigation
Runs: 00:49 New Bot·后台1 cmvl7ghiv (deepseek/deepseek-flash, still running), 23:28 cmvl4kkh4 (grok-4.7), 23:03 cmvl3niba (grok-4.7). thinkingLevel=NULL on all (provider default; grok reasoningTokens ~0, deepseek 0–400/step).
- Model steps dominate. grok-4.7 via lllltt: usage records every ~17–22 s with only 75–1500 out tokens and 0.5–10k new input → ~15 s fixed latency/step (TTFT), ~8 steps for a simple read+patch = ~2.5 min; plus earlier ~5 min silent final calls. deepseek-flash: tool.completed→next tool.called gaps 2–5 s, summary steps 13–29 s; 13 steps in ~3 min.
- Tool calls: 0.01–3 s each (computer.command), computer provisioning 3.4 s once. Tools ≈ 5–10 % of wall time; model ≈ 85–90 %; queue/lease ≈ 0 (run started 0.09 s after creation, no retries, no 429/concurrency errors).
- Context growth: cacheRead grows 15.6k → 93k tokens (deepseek, 13 steps); grok 12k → 101k. File contents/tool outputs accumulate in every step; caching mostly hits, so cost not latency-driven, but final steps with ~100k ctx are the slowest.
- Test-account heavy test since 00:52: no runs on this server besides New Bot's (3 runs in last 15 min) → it is not sharing concurrency here. Not a factor.
- Streaming: grok final calls showed minutes without text deltas (reasoning/tool-arg generation not surfaced); progress events exist (thread.progress) but user sees only "后台任务进行中".
- Probe not done: lllltt key is stored encrypted in DB (not in .env); did not decrypt.
Fixes (impact order): 1) use a fast model for workers (deepseek-flash already ~3× faster/step than grok-4.7 via lllltt) or a lower-latency endpoint; 2) fewer steps: let worker batch reads (parallel tool calls, read both files in one call) and cap per-tool output (e.g. 8–16k chars, head/tail) to keep ctx <40k; 3) explicit low reasoning effort for workers; 4) cap final report max_tokens / short report prompt; 5) surface worker progress (latest tool step / elapsed) in main chat.

## 2026-10-24 01:0x (UTC+8) — "GEO 调研复用了正在写 patch 的 后台1"（prod sha-9073bb4c，只读诊断）
Timeline (UTC+8), dispatcher New Bot cmvl3lzbe…, worker 后台1 cmvl3ni6y… (only slot ever spawned):
- 23:03 task#1 (background_task, request) → done 23:25, auto-outcome delivered. 23:28 task#2 (request) → done 23:36, delivered (nonce bot-message:auto-outcome:cmvl4kkh…).
- 00:49:26 user asks for the patch. Dispatcher run cmvl7g7t5 posted bot_message_sent but NO child_bot card; worker thread compaction generation did not bump (gen=3 = 23:03, 23:28, 01:03 only) ⇒ it used background_task_message on the idle 后台1, not background_task. Code sends that as intent "fyi" (background-tasks.ts:595).
- Worker run cmvl7ghiv (deepseek-flash) ran 00:49:38 → **completed 01:03:03.9** with final text (worker thread seq 10).
- returnBotMessageOutcome: source intent "fyi" ⇒ bot-messages.ts:347 marks botOutcomeReturnedAt=01:03:04 and delivers NOTHING. No auto-outcome message, no dispatcher wake. Patch result silently dropped (still readable in 后台1's thread).
- 01:03:39 user GEO request → run cmvl7yiee calls background_task (new task, child_bot card). freeSlot (background-tasks.ts:348-354): 后台1 has no active run → reused (correct per code); startOnSlot compacts its history (:393-405, FRESH_TASK_SUMMARY) and retitles to "开源 GEO 工具调研". Run cmvl7ypok running. Queue table empty.
- Busy count (1) is correct: only GEO run active.
- Main bot's claim "代码 patch 那个任务还在跑" is FALSE: it finished 36 s earlier, the dispatcher never got the result, and it inferred "still running" without checking status.
Root cause: follow-up to an idle worker = intent fyi ⇒ outcome suppressed (bot-messages.ts:347 + background-tasks.ts:595). Secondary: slot naming by index (后台1) makes a reused slot look like the old task; dispatcher reasserts task state from memory.
Fix proposal (not implemented):
1. background_task_message to an IDLE worker: send intent "request" (or refuse and tell the model to use background_task with full context) so the result auto-returns; ideally new work always goes via background_task.
2. returnBotMessageOutcome: for bg-worker spawnKeys always return outcome regardless of intent.
3. freeSlot: also treat a worker with a just-finished run whose outcome is undelivered (or dispatcher hasn't consumed) as busy; never reuse it for unrelated work until the result is delivered.
4. Card label: show task title + unique task/run id, not just slot "后台N"; or name slots per task.
5. Prompt: before claiming a task status, call background_task_status; statusless claims forbidden.
Recovery now: patch final report is in 后台1 thread seq 10 (run cmvl7ghiv); can be re-forwarded manually.

## 2026-10-25 upstream merge + result-delivery fixes (PR #2, head ab282d67)
- Merged upstream elie222/rakazo main (67 commits) as merge commit dd6a2f47; fix commit ab282d67.
- Fix for the 00:49 dropped patch result / 后台1 reuse incident (lines 140-156):
  - background_task_message to an idle worker is now intent "request" (was "fyi").
  - returnBotMessageOutcome always returns a hidden worker's outcome, whatever the intent; empty worker turns report "（任务已结束，没有输出文字。）".
  - freeSlot skips a slot whose last completed/failed run has botOutcomeReturnedAt=null (held up to 10 min).
  - Task cards: "后台任务：<title> #<REF>"; worker title "<title> #<REF>"; launch returns task_ref.
  - Dispatcher prompt: must call background_task_status before claiming a task is running/queued/finished.
- CI run 39993755504: all green (unit, lint, typecheck, Postgres journeys/upgrade, builds, E2E 1-4/4).
- Image: ghcr.io/fgbhhnnn/rakazo/app:sha-ab282d676f5e98fda1195ab584725fcbb3443101 (not deployed).
- To verify after deploy: repeat the patch→follow-up→new GEO task scenario; the patch result must arrive and GEO must take a different slot.

## 2026-10-24 heavy test (UTC+8) — prod sha-9073bb4c, test account only, model deepseek/deepseek-flash
DB timestamps below are UTC. DB: 0 failed runs; main user-turn runs median ~2–4 s, p90 ~7 s.

### NEW-1 [NEW, fixed in ab282d67, NOT deployed] Follow-up to an idle worker: result silently dropped
Repro: start a short bg task; after it finishes, say "再让它跑 echo X". Main sends message_bot to the idle worker; the worker replies, but the main thread never gets it.
Evidence: main seq 748/751/754 bot_message_sent intent=fyi; worker msgs 145/147/149 intent=fyi; worker run cmvl8wwm000qw07o6ihlkksuf completed 17:30:36Z with botOutcomeReturnedAt set, no bot_message_received in main. The result only shows up when the user sends another message (seq 752/755 "补报").
Rate: intermittent. 2 of 6 follow_idle runs failed (the first batch); the re-run at 02:2x UTC+8 passed 3/3, because the worker itself sent message_bot intent=result.
Root cause: background-tasks.ts:595 sends to an idle worker with intent "fyi"; bot-messages.ts:346-347 (returnBotMessageOutcome) treats a non-request/question source as returned and delivers nothing.

### NEW-2 [NEW] Concurrent wake turns relay duplicate and contradictory results
Evidence: wake runs cmvl8huq…, cmvl8hwpt… and cmvl8hx5x… overlapped 17:18:42–17:18:49Z. Seq 673 reported tasks 1+2, seq 675 repeated task 2, and seq 674 wrongly said TK6A79E0 was still running.
Root cause: executor.ts:10144 withoutMessagesOwnedByOtherLiveRuns (called at 3908) only filters history at load time. background_task_status shows every result to every turn, and main-bot turns per bot are not serialized.

### NEW-3 [NEW] Status/ETA replies give times in UTC
Repro: start `sleep 100`, then ask "现在进度怎样". Reply: "17:48:27 UTC 启动…预计 17:50:07 UTC" (3/3 runs).
Root cause: the test account's timezone is null; current-time.ts:16-20 falls back to UTC, and background-tasks.ts:471-472/487 give started_at/finished_at/queued_at as ISO Z. Nothing tells the model which zone to use, and there is no default from the browser or locale.

### NEW-4 [NEW] DeepSeek workers' shell commands using `$?` are refused by the guard
Evidence: worker reports at seq 677/698/701 ("被 shell 工具的校验规则拦下", "会话被中断"). executor.ts:2606-2611 (shellTokenReason / unresolvedVariableReason). This leads to retries and slower runs.

### NEW-5 [NEW, minor] Skill text says at most 3 parallel tasks; the real limit is 4 (builtin-skills.ts:10)

### NEW-6 [NEW, model routing] An unrelated new request was routed into an idle worker as a follow-up (S8, seq 750–752); NEW-1 then dropped its result.

### NEW-7 [NEW, minor] Says "已经在后台生成了" before the worker has finished (seq 613)

### Not bugs / harness notes
- redirect 3/3: the harness said FAIL (old_seen) because the main bot quotes the old token while confirming the cancel. DB: the old worker was cancelled every time (17:57:04, 17:59:42, 18:00:29Z) and a new worker finished the new command. PASS. Note: a redirect always cancels the task and starts a new one; it never steers the existing worker.
- stop_one 3/3: the harness said B_seen for the same quoting reason. running went 3→2, B was cancelled (18:01:18Z), and A and C finished. PASS.
- No reasoning text leaked, no empty streams, and no paraphrased repeats inside a reply.
- burst_busy 3/3 PASS: all 4 quick questions answered in 4.8–9.5 s (harness poll time) while 3 workers were busy. The harness only reached 3 running, not 4 or more.

## 2026-10-24 03:xx (UTC+8) fixes for NEW-2..NEW-7 (commit 772f4211, NOT deployed)
- NEW-2: worker-result wake runs (trigger bot_message) of a dispatcher wait before claiming until no other leased/running run of the same bot+thread and no earlier queued wake exists (oldest first, poll 400 ms, bounded by RAKAZO_DISPATCHER_TURN_MAX_MS). Prompt: a wake relays only its own result(s), never repeats or contradicts earlier relays. Fix is in executor.ts (waitForEarlierDispatcherTurns).
- NEW-3: timezone falls back user → Space creator → RAKAZO_DEFAULT_TIMEZONE (new optional env) → UTC (resolveRunTimeZone). background_task_status times (started_at/finished_at/queued_at) are given in that zone with an offset label, e.g. "2026-10-24 01:48:27 (UTC+08:00)", plus time_zone.
- NEW-4: the desktop-protection guard accepts $? $# $$ $! (they always expand to digits); unresolved-variable refusals now say how to proceed (literal value, or a script file run with bash).
- NEW-5: the Heavy Task Workflow skill now says 最多同时 4 个，超出的自动排队; a test ties it to backgroundTaskConcurrency().
- NEW-6: routing rule (dispatcher prompt + status note): follow-ups go to an existing worker only when, by meaning, they continue that task's work; different subject/deliverable → new background_task even if a worker is idle; when unsure, start a new one.
- NEW-7: rule: never say done/generated/ready before the worker result arrives or status shows completed.
- CI 40006873999 green (Web E2E 1/4 flaked once on bot-organization "Move to → New section" submenu, web-only and unrelated; it passed on re-run). Image ghcr.io/fgbhhnnn/rakazo/app:sha-772f4211635a4d5890cf26ecf6ff115e73cd17bf.
- To verify after deploy: 3 parallel short tasks finishing together → one relay each, no duplicates; a status/ETA reply in UTC+8 for the test account (set RAKAZO_DEFAULT_TIMEZONE=Asia/Shanghai if its owner has no timezone); a worker running `cmd; echo $?`; an unrelated request while a worker is idle → a new task.

## 2026-10-24 07:0x (UTC+8) deployed 772f4211 to production
- Before: 0 active runs. Backups: /data/backups/pg-20261023-225645/rakazo.dump (17 MB, server UTC ts), /opt/rakazo/.env.bak-20261023-225645, docker-compose.images.yml.bak-20261023-225645.
- Compose synced from infra/compose/docker-compose.images.yml@772f4211 with local lines kept (RAKAZO_IMAGE_TAG, RAKAZO_UPDATER_URL/TOKEN). Added RAKAZO_DEFAULT_TIMEZONE=Asia/Shanghai (present in api and worker).
- Migrations applied 23:04:07Z: 20261023100000_home_object_storage, 20261023120000_external_messages_bot_sender_idx_concurrent (background_task_queue was already applied).
- All services healthy, site 200, no error/warn logs other than csp.violation x2.
- OTA runtime 1.0.7: production group 31bf6a21-0c74-4934-8db4-b3c05c283fa6, preview group a2b0f311-e356-4d98-826a-9669f24070d1 (ios+android).
- Smoke (ds/smoke.py): followup_idle PASS (result relayed in 26 s); unrelated_new PASS (new task "#T64KEIYA" card); status_tz PASS (times shown as "07:13:57 (UTC+08:00)"); dollar_q PASS (the harness said FAIL only because the bot warned in advance that it "might be blocked"; the worker ran `false; echo X-$?` -> X-1 and was not blocked); burst x3 PASS (one relay per result in order, no duplicates or contradictions).
- Minor, open: the main bot's text still says "后台1/后台2" and not the task name; it also told the user up front that `$?` might be blocked (stale memory from earlier turns).
- Rollback tag: sha-9073bb4ccd3d1466a32690e949c1e5d63120b6b7.

## 2026-10-24 07:32–08:10 (UTC+8) full test run on production 772f4211 (test account, bot 调度测试, 1 bot, serial)
Results (harness ds/suite3.py, suite4.py; output ds/full.out, s4.out, run.log):
- quick x3 PASS (3.6–4.4 s); burst x5 PASS (all answered by 8.7 s)
- ambiguous non-stop ("好的不急"/"停车场的停字"/"我先去吃饭了") PASS: task kept running and finished
- indicator count PASS (backgroundTasks.running hit 3 for 3 tasks); labels FAIL -> NEW-8
- wake_overlap (v1 harness sent too early; redone as S28 in suite4)
- error_cmd PASS (real "No such file" relayed); dollar_warn PASS on this run (no warning)
- stop_all PASS (3 running -> 0 in 9 s); stop_one PASS by DB/state (3->2, B cancelled; A and C relayed; harness B_seen only from the confirmation quoting B)
- report_path PASS with bugs NEW-9, NEW-10
- queue6 PASS (max running 4, queued 2, all 6 relayed); burst_busy PASS (4 running + 1 queued, 4 quick answers 3.8–6.5 s, queued 5th reported as 排队, all 5 relayed once each)
- busy_unrelated PASS (quick answer 4.5 s while busy; second task 15 s); redirect PASS (26 s)
- longshell PASS (sleep 170 dispatched 07:54:00, relayed 07:57:09 = ~190 s, ~20 s overhead)
- files PASS (csv + /tmp file); followup to busy worker (poem) PASS; followup_idle PASS (21 s)
- web/API: / and /login 200, /healthz 200; bots/list shows only New Bot + 调度测试 (workers hidden); no error/warn logs in api/worker for the window except one /api/voice warn
- upstream-merge regression: OBJECT_STORAGE_BUCKET unset, homes on disk; file attach/report flows work.
- Not tested: model/provider failure (would need changing the test bot's model or provider key); restart lease-release (no restart allowed).

### NEW-8 [FIXED f24db7a3] Main bot calls tasks "后台1/后台2" instead of name #id
Root cause: worker results arrive with fromBotName "<bot> · 后台N", and background_task / background_task_status returned `worker: "<bot> · 后台N"`; nothing gave the model the #ref in the result. Fix: worker results are prefixed 【后台任务：<title> #ref】, tool outputs drop the slot name, prompt says to use name #ref. Same commit: prompt says $? $# $$ $! are allowed (stale "may be blocked" warning).

### NEW-9 [FIXED f24db7a3] Report file attached twice (seq 1202 and 1203)
Root cause: the dispatcher called attach_file with one spelling of the path; attachWorkerReportFiles deduped by raw string only, so the report's absolute path attached it again. Fix: dedupe by resolved workspace path (attachedPathKey).

### NEW-10 [FIXED f24db7a3, prompt] Dispatcher told the worker "your shell cwd is bots/<dispatcher id>"; worker wrote two copies
Fix: background_task description says the worker has its own home; give an output location only when the user asked, as an absolute path. Also corrected "Up to 3 run at once" -> 4 with queue.

### NEW-11 [FIXED ca97c728] Shell commands reach workers/dispatcher as "&amp;&amp;"
Every relay said "消息里的 `&amp;&amp;` 只是转义显示". Root cause: buildBotMessageWakePrompt HTML-escaped the whole peer body (escapePromptData). Fix: escape only tag-like "<" (escapeBotMessageBody), so the wrapper cannot be closed but && 2>&1 and "< file" stay verbatim. Tests added.

### 2026-10-24 08:05–08:20 (UTC+8) additions
- **NEW-12 (FAIL→fixed aae7d679)** upload: user CSV upload (artifact cmvlmy1xs…) never reached disk. Dispatcher has no work tools so the lazy computer never started and materialization never ran; worker (own home) also could not resolve relative `attachments/<id>.csv`. 2/2 reps failed (rep 2 harness "ok" was a false positive; the text says file not found). Fix: on background_task with thread attachments, materialize into dispatcher home and append `/bots/<dispatcher>/attachments/…` (file tools) + `../<dispatcher>/attachments/…` (shell) to the worker task. Unit test added. Needs re-test after deploy.
- **Compaction (19097def, 9f1cdb4f)**: in-run compaction for hidden worker runs at 75% of the active model contextWindow, summarize with same model, keep user turns + last 8 msgs; 5 unit tests. Summary-call token usage is not recorded in usage records (follow-up).
- contextWindow: test account has no own model credentials (models/credentials = []); runs use deepseek/deepseek-flash (406 runs) and openai-compatible/grok-4.7 (267 runs) via shared credentials. The per-credential contextWindow lives inside the encrypted secret, so it can't be read read-only without decrypting; models/list reports contextWindow null for both → code default DEFAULT_MODEL_CONTEXT_WINDOW = 262144 applies unless the owner set a value on the credential.
- S28 wake_overlap2: still running at report time.

### 2026-10-24 (UTC+8) PR #2 review findings P1-1..P1-8, P2-1..P2-4 (feat/heavy-task-robustness)
Verified each against aae7d679; all 12 confirmed and fixed in one commit (single push).
- P1-1 started-before-start, no recovery → task row lifecycle queued→claiming(lease)→started→completed/failed/cancelled; recoverBackgroundTasks binds expired claims via delivery nonce `bgtask:<row>:<attempt>` or requeues (failed after 3).
- P1-2 in-process launchLocks only → claimSlot locks the dispatcher bot row (`SELECT … FOR UPDATE`) across processes.
- P1-3 activeRun read outside tx → slot busy check (rows holding the worker + live worker run) inside the locked tx.
- P1-4 drain break + freeSlot bypass → every task inserted queued then drained FIFO; a failed head start requeues it and stops the drain.
- P1-5 findFirst+unconditional update → all status changes are CAS updateMany on expected status/lease owner.
- P1-6 task_id = worker id, title from mutable worker title, 10-min hold → task_id is row ref; results labelled from the row (`name #ref`); row finalized when result delivered (markBotOutcomeReturned) or by reconciler; late result of an older run on a reused slot is credited only to its own row.
- P1-7 worker could ask_user/message_user/message_bot/message_agent → always disabled for workers (tool-surface test).
- P1-8 waitForEarlierDispatcherTurns result ignored → if an earlier turn is still alive (live lease or earlier queued), the wake is re-enqueued +3 s instead of running in parallel.
- P2-1 dispatcher threw "Bot has no computer" and used getRunComputer for attachments → dispatcher turn runs without a computer; uploads travel as file/image blocks on the worker's inbound message.
- P2-2 duplicate by name only → by content hash (name+agent+instructions+task normalized).
- P2-3 report paths with spaces/Windows rejected; dedupe by raw path → parser accepts spaces/`C:\`, Windows paths are skipped for reading, dedupe also by resolved path key.
- P2-4 test asserted "t6" → asserts `t6 #<ref>` from the row.
Migration (additive): 20261024120000_background_task_lifecycle (new nullable columns + attempts default 0, 3 indexes; legacy `started` rows closed as completed).
Local: tsc clean (db, adapters, testkit, api, worker, web); full vitest 13574 passed; local Postgres 17 integration: 53/54 suites pass incl. new background-task-lifecycle.postgres.test.ts (claim race across two module instances, crash recovery, FIFO+queued cancel, slot reuse attribution, wake deferral). bootstrap-owner.postgres failed locally only because the box's corepack pnpm is v11 vs required 9.15 (env, not code).
Needs live re-test after deploy: upload → worker (attachments as blocks), NEW-12.

### 2026-10-24 — Refactor for the "new logic in new files" rule (PR #2, after 0ebe1cda)
- New modules: background-task-recovery.ts (recoverBackgroundTasks), task-identity.ts (newTaskRef/taskTitle/backgroundTaskHash),
  worker-tool-policy.ts (BACKGROUND_TASK_TOOL_NAMES/WORKER_ALWAYS_DISABLED/workerDisabledTools/workerToolSurface),
  task-attachments.ts (attachmentBlocks/dispatcherTaskAttachments), dispatcher-turn-guard.ts (earlierDispatcherTurnAlive/deferDispatcherWake/dispatcherComputerPlaceholder).
  background-task-rows.ts gained lifecycle constants, taskDeliveryKey, finalizeBackgroundTaskAfterReturn, backgroundTaskLabel.
- Upstream files reduced to hook lines: executor.ts +25/-19, bot-messages.ts +24/-13, job-reconciler.ts +2, thread-artifacts.ts +1/-1 (export); thread-listing.ts change reverted.
- background-tasks.ts re-exports the moved API (no duplicate definitions).
- Local: tsc clean (db, adapters, testkit, api, worker, web); biome no new warnings; vitest 13574 passed/454 skipped;
  postgres suites 52/52 (278 tests) with --no-file-parallelism. Parallel run on one shared DB gives cross-file interference (4 fails), not a code issue.
- Image sha-0ebe1cdacff621cec96213e99ea54e4062303b37 published (run 40051374251 success); superseded by the new head.

## 2026-10-24 10:19 (UTC+8) deployed sha-24f02dfe to production (user-approved)
- CI 40052312232 all green (https://github.com/fgbhhnnn/rakazo/actions/runs/40052312232); image ghcr.io/fgbhhnnn/rakazo/app:sha-24f02dfe556a8c88b100b02c8149273c944cab49 published by workflow_dispatch run 40052769747.
- Pre-check: 0 active runs. Backups (server UTC ts 20261024-021440): /data/backups/pg-20261024-021440/rakazo.dump (21.9 MB), /opt/rakazo/.env.bak-20261024-021440, docker-compose.images.yml.bak-20261024-021440.
- Compose unchanged since 772f4211 (server = branch + local lines), no sync. Only RAKAZO_IMAGE_TAG changed. Deploy log /root/deploy-20261024-021440.log.
- Migration 20261024120000_background_task_lifecycle applied 10:19:41 UTC+8; 0 unfinished migrations; 12 legacy 'started' rows → completed; new columns present.
- api/worker/web/supervisor on sha-24f02dfe, healthy, 0 restarts; site 200, /health 200; logs: 0 error/fatal, 4 csp.violation warns (known).
- No OTA: no mobile changes since 772f4211.
- Smoke (2 msgs, test account, ds/smoke2.py): quick reply PASS (7.2 s); bg task relay PASS (task #TWE24FEQ, card "后台任务：echo … #TWE24FEQ", attempts 1, workerRunId bound, finalized 0.15 s after the run). The whole relay took 220 s: the shell step took 6 s and the worker's final model call took 3m23s (model latency, see the 00:58 note).
- Rollback: sha-772f4211635a4d5890cf26ecf6ff115e73cd17bf.

## 2026-10-24 (UTC+8) — upstream sync: elie222/rakazo main 1e92d28a (52 commits) into feat/heavy-task-robustness (PR #2)
- Commits: merge cfb3471e (parents 24f02dfe + 1e92d28a, no rebase) + follow-up f12885f7. One push (24f02dfe..f12885f7, fast-forward).
- Dispatch: upstream direct Postgres run dispatch (RunJobPublisher/RunWorkerHost) adopted; our Graphile lanes + GRAPHILE_RESERVED_CONCURRENCY removed (compose too).
  Dispatcher wake ordering now defers via wakeAt +3 s instead of waiting inside a RunWorkerHost slot. Lease release on shutdown kept (status unchanged → legacy retry trigger not fired).
- New modules (executor.ts hooks only): dispatcher-mode.ts, dispatcher-relay.ts, run-cancel-watch.ts, background-task-tools.ts. executor.ts vs upstream +253/-47.
- Tests added: worker-shutdown.postgres.test.ts (released lease picked up once by another direct-dispatch worker; deferred wake not picked early),
  cross-space test (dispatcher + same-space hidden worker allowed), routine-default-timezone.test.ts.
- Fixes found by tests: child-bots.test expectations include hidden-worker filter; ja mobile catalog (upstream new) missing 5 of our strings; ja web .po 11 empty strings filled.
- Timezone: upstream de0ccc64 (routines default to the user's zone, then UTC) + ours → user zone, then RAKAZO_DEFAULT_TIMEZONE, then UTC.
- Migrations from upstream (apply after prod's 20261024120000_background_task_lifecycle): 20261023100000_signup_survey, 20261023120000_bot_cross_space_communication,
  20261023180000_run_dispatch_timing, 20261024120000_computer_home_revision_at. Verified on a scratch DB at the 24f02dfe state: 140 applied, 0 unfinished.
- Local: pnpm check 22/22, pnpm lint 0 errors, vitest 912 files/14033 passed. Postgres suites sequential on one DB: 56/57; the one failure
  (background-task-lifecycle FIFO) is cross-file leakage — takeover-chat.postgres sets deployment default model openrouter/gpt-4o; passes on a fresh DB, and CI's harness clones a fresh DB per suite.
- Mobile changed (upstream settings/signup-survey/models etc. + ja catalog) → OTA needed after deploy. Not deployed.

## 2026-10-24 12:07 (UTC+8) — upstream-sync batch: 3 dispatcher fixes (commit 10962473)
- Fix 1 (worker result truncation): new `packages/adapters/src/worker-outcome-relay.ts`. A hidden-worker result over the 8000-char bot-message limit is no longer clamped. The full text becomes the attachment `result-<REF>.md`, owned by the dispatcher. The relay is a short note with #REF, the char count and the 文件： section. The dispatcher turn auto-forwards the attachment (`forwardWorkerRelayAttachments`). If there is no artifact store or the attach fails, the result is clamped with an explicit "已截断；共 N 字" note. WORKER_INSTRUCTIONS now say: keep the final reply concise, put material over ~3000 字 in ./jobs/<任务>/out/report.md, and list it under 文件：. Note: the job-reconciler relay path has no artifact store, so it uses the clamped fallback.
- Fix 2 (dispatch + answer in one turn): guidance sentence added to BACKGROUND_DISPATCH_GUIDANCE. New `dispatcher-reply-guard.ts` with a turn ledger that records background_task* results. If a turn started or queued a new task and its reply is over 400 chars, the reply is logged and trimmed to its first 1–2 sentences (≤200 chars). Skipped when the turn was woken by a bot/worker message or the text relays another #REF or a 【后台任务：…】 result.
- Fix 3 (false "我已经让它…" claims): generic claim patterns (a done-marker plus an ask verb plus the worker; 已经 + 安排/派/启动/交给…; 开了…后台; done-marker + 补发/重发; English I've asked/started/re-sent…). Questions and offers are excluded. If no background_task* call succeeded that turn, the claim sentences are stripped and ONE corrective turn is queued: same trigger and source message, retryOfRunId, and a prompt marker so it is never re-prompted twice. Skipped when a steering continuation is queued.
- Tests: worker-outcome-relay.test.ts (9) and dispatcher-reply-guard.test.ts (25). Full unit run: 914 files / 14067 tests pass. Full postgres run on freshdb: 57 files / 304 tests pass. pnpm check passes; lint has 0 errors.
- CI on 10962473: all green. ci run https://github.com/fgbhhnnn/rakazo/actions/runs/40061035732; Computer runtime, desktop-macos-screenshot and publish-server-image (validate) also green. Image published by workflow_dispatch run 40061038021: ghcr.io/fgbhhnnn/rakazo/app:sha-109624730345784184d9ab739c860d92686a4da4 (12:14 UTC+8). Not deployed.

## 2026-10-24 12:27 (UTC+8) deployed sha-10962473 to production (user-approved) + OTA
- Pre-check: 1 running worker run; waited until it completed (12:22), then deployed. Backups use server UTC timestamp 20261024-041947: /data/backups/pg-20261024-041947/rakazo.dump (24.7 MB, 12:19) and rakazo-predeploy.dump (24.7 MB, 12:22, taken right before the deploy); /opt/rakazo/.env.bak-20261024-041947 and docker-compose.images.yml.bak-20261024-041947.
- Changes: removed the `GRAPHILE_RESERVED_CONCURRENCY:` line from the worker in the compose file. Server compose now equals the branch except for the local lines (RAKAZO_IMAGE_TAG, RAKAZO_UPDATER_URL/TOKEN). .env: only RAKAZO_IMAGE_TAG changed (same key set; RAKAZO_DEFAULT_TIMEZONE=Asia/Shanghai kept and present in api and worker). Log: /root/deploy-20261024-041947.log.
- Migrations applied 12:27:35 UTC+8: signup_survey, bot_cross_space_communication, run_dispatch_timing, computer_home_revision_at. Total 140, 0 unfinished.
- api/worker/web/supervisor all on sha-10962473 (OCI revision label matches), 0 restarts, healthy. Site / 200, /health 200, /healthz 200, /login 200. The public index-C4yP-HTn.js matches the new web container. Logs over 20 min: 0 error/fatal; 4 csp.violation warns (known) and 1 http warn.
- Dispatch: new runs after the deploy were picked up immediately on the direct-dispatch path (6 completed and 1 running by 12:37, fence 1).
- ISSUE (self-healed): a hidden-worker run created 12:26:44, just before the restart, waited ~5 min. Its computer was in "suspending" when the supervisor restarted (stamp 12:26:49). The run requeued itself every ≤10 s (computer busy, fence up to 27) until the stale-suspend reclaim (BOOT_CLAIM_STALE_MS ≈ 5 min) took over at 12:31:5x; then it completed. No DB writes by us. Possible follow-up: deploy only when no computer is suspending, or shorten the stale-suspend window after a supervisor restart.
- OTA runtime 1.0.7 from 10962473 (ios+android): production group 6e4ff26e-cf8f-4a92-b4d8-6a77477691c8, preview group 72d7d80e-b9ca-43cf-9f5a-cb454ff84dc7. The new upstream native module rakazo-file-drop (Android) is loaded via requireOptionalNativeModule, so the 1.0.7 binary simply has no file drop; there are no new npm native deps in apps/mobile/package.json.
- Rollback: sha-24f02dfe556a8c88b100b02c8149273c944cab49 (restore the .env/compose .bak files; the migrations are additive).

## 2026-10-24 (UTC+8) full test pass sha-24f02dfe/10962473 (测试bot)
测试账号 ccxxyy0815@gmail.com，bot 调度测试 cmvkqqzxd000307o2bt8f9kd4；只走 API；最多 4 个 worker + 主 bot 并发。Harness：ds/suite5.py（输出 ds/s5.out、run.log），ds/s10b.py（S10 单项重跑）。
镜像：S1–S11 跑在 sha-24f02dfe（11:01–12:26）；12:27 部署 sha-10962473 后，S12a/S12b/S13/S10b 跑在新镜像（12:26–12:46）。

| # | 场景 | 结果 | 证据 / 时间 |
|---|---|---|---|
| 1 | 主 bot 快速回复 | PASS | 单条 3.9–4.2 s（3/3）；5 条连发全部答对，最后一条在 9.4 s 时回复，合成 3 条 bot 消息 |
| 2 | 6 个任务：上限 4 / FIFO / 排空 | 上限、排空 PASS；FIFO FAIL；卡片缺失 | 最多 running 4、queued 2；槽位空出约 0.2 s 后就接下一个任务。见 BUG-A、BUG-B |
| 3a | 追问空闲任务 | PASS | #TM2H3TNF 已完成后追加 echo TKE21503，由同一 worker 执行，215 s |
| 3b | 追问忙碌任务 | PASS | #TVJ2HB9J（sleep 90）中途补充 echo TKCE66E9，两个输出都有回报 |
| 3c | 改向运行中任务 | PASS（harness 误判） | #T28YGU84 被取消（"终止了 1 个进程"），新任务 #T2UGWEZT 输出 TKBE4506；worker 侧从未产出 TK6B47A7。harness 命中的是状态表里的 `TK6B47A7` |
| 3d | 改向排队中任务 | PASS（harness 误判） | 排队的任务 6 TKF7CEFD 被取消，从未下发给 worker；新 #TBSMWQWL 输出 TK29A0F1。ref6=null 是因为排队任务没有卡片（BUG-B）|
| 4a | 全部停止 | PASS（harness 误判） | 3 个 running 在 9 s 内归零（seq1467）；三个 worker 都没有 result。harness 命中的是"不会有 `TKxxx` 的输出"这句文字 |
| 4b | 按 #REF 停一个 | PASS（harness 误判） | 停掉 #TFYZAADD（B）；A #TFYT07NN 和 C #TFYP0HOS 正常完成；B 的 worker 没有 result |
| 4c | 含"停"字但不是停止的消息 | PASS | 发了"停车场的停字…/别停…/我先停一下…去吃饭"，#TN1AIC2O 照常完成 |
| 5 | 槽位复用后 #REF 不串 | 结果头 PASS；中转文本 1 次标错（BUG-H，新镜像）| #TT2JQ33N 与 #TXLFNKH8 在同一个 worker 上，结果头各自正确；S2 中任务 6 复用后台1，结果头仍是 #TBSMWQWL |
| 6 | 同名不同内容 | PASS | "统计 #T2MNTBX3" 和 "统计 #T2MS11YH" 都跑完 |
| 7 | worker 不问用户、不给别的 bot 发消息 | PASS（人工判定）| 主 bot 先用 ask 问了文件名（主 bot 允许这样做）；worker #TN3B8WX0 报告自己没有 message_bot/list_fleet 工具；New Bot 新消息 0 条。小问题：主 bot 在任务里指示 worker 去用 message_bot/list_fleet |
| 8 | 上传 CSV 让任务读取 | PASS | up TK3C7DFF.csv（文件名带空格）求和得 23，正确；229 s |
| 9 | 报告路径带空格时附上文件 | PASS | "my reports/report TKEEB5F6.md" 以 file 块附上（seq1534）；226 s |
| 10 | worker 结果 wake 期间用户来消息 | PASS（S10b 重跑，新镜像）| 首跑的问题在 wake 结束后才发出，没有真正重叠。重跑：wake 开始于 04:44:52Z，2.4 s 后发问（seq1575）；wake 的中转消息 seq1576（04:45:04Z），问题的回答 seq1577（另一个 run），各 1 条，没有重复，顺序正确 |
| 11 | 长任务速度 | PASS（结果正确）| 前 20000 个质数之和 2137755325 正确；5 s 出卡片，worker 用 3m52s，中转 +4 s |
| 12a | 错误命令 | PASS（新镜像）| 原样报出 "No such file or directory"，exit 1；322 s 是因为碰上部署重启（12:26:44 创建的 worker run 等了约 5 分钟）|
| 12b | shell 中 `$?` 不被拦截 | PASS（新镜像）| `bash -c 'exit 3'; echo TKD1D51C-$?` 输出 TKD1D51C-3，没有拦截字样 |
| 13 | 状态回复使用 UTC+8 | PASS（harness 误判，新镜像）| "现在是 12:36（UTC+08:00），也就是 04:36 UTC；任务 12:35:59（UTC+08:00）开始"。harness 不允许出现 UTC 时间，属于判定写得太严 |

### 真实问题
- **BUG-A 同一批任务内 FIFO 乱序**（24f02dfe，1 次）：一条消息依次派发 1..6，主 bot 一轮里发出 6 个 background_task。结果 1、2、4、5 先启动（seq1404–1411），3 和 6 进了队列（seq1414 写着"排队：任务3（第1位）"）。复现：一条消息开 6 个编号任务，前 4 个 sleep 90、5/6 sleep 20，然后看 bot_message_sent 的顺序。原因未定：可能是并行 tool call 抢 claimSlot，也可能是模型调用顺序；靠 API 无法区分。
- **BUG-B 排队任务没有 child_bot 卡片**（24f02dfe）：任务 3 TKEB9F56 和任务 6 #TBSMWQWL 从排队转为启动时（seq1416、1419），只有 bot_message_sent，没有"title #REF"卡片。用户在界面上看不到这两个任务的卡片和 #REF（#REF 只出现在主 bot 的文字里）。
- **BUG-C 旧上传附件被带进之后所有 worker 任务**（两个镜像都有）：每条下发给 worker 的任务都带着这个线程以前上传的 CSV。例如 S2 的 sleep 任务带了 up_TKAB2306.csv 和 up_TK8186FE.csv（08:xx 的旧上传）；S10、S11、S12 的任务都带了 S8 的 up TK3C7DFF.csv（worker 后台1 seq381/384/387）。复现：先上传一个 CSV 并完成任务，再开一个无关的 echo 任务，看 worker 线程里 bot_message_received 后面跟着的 file 块。dispatcherTaskAttachments 应该只取触发这次派发的那条用户消息的附件。
- **BUG-D 首次 shell 调用返回"被中断、结果未知"**（24f02dfe）：S2 中 4 个 worker 同时启动，其中 2 个（#TBF7LVQI、#TBFMZ269）第一次 shell 调用就收到这个结果，worker 只能重跑，耗时翻倍（sleep 90 的任务用了 102 s 的 shell 步骤，含 2 次调用）。
- **BUG-H 中转文字把结果标到错误的任务名**（10962473）：seq1561 中转 #TJWZVVJK（exit3/`$?`）的结果，开头却写成 "`cat /nonexistent/zz_file` 这个任务已经跑完了"，那是上一个任务。worker 给的结果头 seq1560 是对的。这是模型层面的错，但正是场景 5 要防的情况。
- **BUG-F（疑似）报告里列出的 .py 文件没有附上**（24f02dfe）：S11 worker 报告末尾有"文件：\n- /home/user/rakazo-home/bots/cmvkqu4et000j07s8vbnvjdi9/prime_sum_20000.py"，worker 步骤里也有 Attach file，但主 bot 线程没有 file 块。同样格式的 S9 .md 文件是附上了的。
- **小问题 G**：用户能看到的回复里反复出现"由后台1执行""后台2"之类的槽位名，和"隐藏 worker、用 title #REF 指代任务"的设计不符。
- **速度 E**：几乎所有 worker 的单轮都要 3–4 分钟，连 echo 也是（echo 197–227 s，sleep 25 用了 228 s，sleep 60 用了 257 s）。shell 本身只要几秒，慢在 worker 最后一次模型调用。主 bot 的回复和中转只要 2–5 s。也有快的：TKADC031 用了 3 s，S2 的任务 6 用了 6 s。

### Timings（UTC+8）
- 主 bot：单条 3.9–4.2 s；5 条连发 5.6–9.4 s 全部答完。
- 卡片在发消息后 3–8 s 出现；排队任务在槽位空出后约 0.2 s 下发。
- 停止：全部停止 9 s 归零；按 #REF 停止约 10 s 内主 bot 确认。
- echo 往返约 3.3–3.8 min；sleep 90 ×4 并发 96–110 s；CSV 229 s；报告文件 226 s；质数长任务 3m52s。

## 2026-10-24 修复 测试bot 全量测试发现的 A–H（分支 feat/heavy-task-robustness，c2d1c108 + 58a544fc，未部署）
- **A FIFO 乱序**：Pi runtime 会并发执行同一轮里的 tool call，6 个 background_task 同时抢 claimSlot（生产库：任务3 TBFVZRKG 03:01:34.895 才写入，晚于任务5 的 .572）。修复：新文件 dispatch-tool-order.ts，background_task / _status / _message / _cancel 标成 sequential，同一轮按模型发出的顺序执行。测试：pi-runtime-tool-dispatch.test.ts。
- **B 排队任务没卡片**：卡片只在 background_task 的返回里发；从队列启动的任务（drainQueue）没有发卡片的路径。修复：新文件 background-task-cards.ts（backgroundTaskCard / announceQueuedTaskStart），drainQueue 启动任务时补发 "后台任务：title #REF" 卡片（尽力而为，不 await，不占队列锁）。测试：lifecycle postgres FIFO 用例断言只有 f4 有一张卡片。
- **C 旧上传被带进所有任务**：dispatcherTaskAttachments 会把最近几轮的上传都带上。修复：只带本轮/本次改向消息的附件；更早的上传只有任务文本里提到文件名（或 ≥6 字符的文件名主干）时才带。测试：task-attachments.test.ts。
- **D 首次 shell 返回"被中断、结果未知"**：4 个 worker 同时首次用共享电脑，只有一个能 claim 启动，其余拿到 ComputerBusyError → 第 1 次尝试 setup_failed，重试时已登记的 shell effect 被判 uncertain。修复：computer-busy-retry.ts，后台 worker 在工具内最多等 90 s（可中止）再放弃；其他 run 保持快速失败/重排队（第一次推送对所有 run 生效，CI 的 executor-lifecycle "leaves a booting computer alone" 超时，第二次提交收窄）。测试：computer-busy-retry.test.ts。
- **E worker 3–4 分钟**：是我们的问题。worker 结束前同步执行 workspace checkpoint，在 e2b 上导出整个工作区约 200 s（tool 完成 04:32:24 → 最终消息 04:35:45）。修复：worker-checkpoint.ts，开启 idle sleep 时隐藏 worker 不再阻塞做终态 checkpoint（idle sleep 关机前会做同样的 checkpoint）。剩余风险：idle sleep 自己的 checkpoint 期间电脑处于 suspending 约 200 s，这时启动的 worker 仍会等待（上游行为）。
- **F .py 没附上**：EXTENSION_MIME_TYPES 不认 .py 等源码扩展名，附件被丢弃。修复：core/source-text-extensions.ts，常见源码/配置/日志扩展名按 text/plain 处理。
- **G 槽位名漏进回复**：主 bot 历史和 wake prompt 里直接用 worker 名 "X · 后台N"。修复：core/worker-names.ts（withoutWorkerSlot），历史文本、peer update、取消回执里都改成 "X · 后台任务"；UI 隐藏规则不变。
- **H 中转标错任务**：同一槽位先后跑两个任务，wake prompt 的发送者都是 "X · 后台1"，模型把结果算到上一任务。修复：worker 结果唤醒主 bot 时，发送者写成 后台任务「title #REF」。本质是模型层错误，这里是降低概率，不能保证杜绝。
- **测试稳定性**：lifecycle FIFO/并发用例在 baseline 也失败——测试环境里 worker run 一启动就因 "Connect a model" 失败，下一次 launch 的 recovery 把 f1 终结成 failed、腾出槽位，队列顺序变成取决于时序。改成测试里不执行 worker run（jobs.enqueue 置空），断言不变。pi-offline 用例 event.findMany 没有 orderBy，偶尔先返回 shell 事件；加 orderBy seq。

## 2026-10-24 14:50–15:43 (UTC+8) long tests L1–L4 on production sha-58a544fc (test account, cap ≤20)
| Test | Result | Notes |
|---|---|---|
| L1 #THLFV7BZ (1 h+ data-analysis report) | PASS | 14:50:18 → 15:43:33 (53 min), worker lease renewed throughout, 128 tool calls; report_L1.md 101 KB (18,836 CJK chars > 12,000 required) + stage_summary.csv relayed. Issue: dispatcher re-attached it as "L1 数据分析报告" (no .md). |
| L2 (prime / π steer / sort cancel / Titanic 6-step / fib, FIFO) | PASS with bugs | prime relayed ~11 s; π honoured steer but relay said "由后台4执行"; sort cancelled; Titanic 225 s exit 0 + files; fib relayed; FIFO kept. Ack trimmed mid-sentence; a queued task's card missing. |
| L3 (steer + cancel by meaning) | PASS with bug | steer reply 8 s; cancel ~10 s; after cancel the bot said the next task was "still queued #1" although it had just started. |
| L4 (echo during load) | PASS | L4-7Q2K echoed at +10 s. |

### Fixes (feat/heavy-task-robustness, after 58a544fc, NOT deployed)
- Bug 1 task card hidden: a queued task started inside a bot_message dispatcher run; that run's chatter is folded and the child_bot card went with it → background-task-card.ts (isBackgroundTaskCardBlock) kept by message-visibility + thread-message-pages.
- Bug 2 ack fragments: acknowledgementOf cut at 200 chars mid-sentence/heading → dispatch-acknowledgement.ts keeps whole prose sentences only (1–2) and appends a status line naming every task started/queued this turn (#REF, queue position).
- Bug 3 stale queue after cancel: cancel result had no queue state → queue-after-cancel.ts adds started_from_queue / still_queued(+position) and a note.
- Bug 4 / G slot-name leak: worker slot names reached the user via (a) the final reply (guard), (b) worker result/status text relayed into the dispatcher's model context, (c) the result-<REF>.md file, (d) dispatcher mid-turn narration and message_user → worker-slot-mentions.ts slotFree() applied in messageBot (worker senders), workerOutcomeRelay, guardDispatcherReply and the three executor mid-turn publish points.
- Bug 5 attachment name without extension: attach_file `name` replaced the file name → attachment-display-name.ts keeps the file's extension ("L1 数据分析报告.md").
- Observation: `nohup … &` in a worker shell held the call for 300 s (stdout inherited) — guidance: `setsid nohup … </dev/null >log 2>&1 &`. Steering latency ~98 s once (worker mid tool call).

## 2026-10-24 19:35–20:10 (UTC+8) upstream merge 1e92d28a..0f509715 (13 commits) into feat/heavy-task-robustness
- Conflicts (2): executor.ts timezone — kept ours `resolveRunTimeZone` (user → space owner → RAKAZO_DEFAULT_TIMEZONE), kept upstream `lateRoutineNote` block (uses the routine's own stored timezone, which is what its crons are evaluated in); child-bots.test.ts imports — union.
- Local CI env issue (not a code bug): box Postgres runs with timezone Asia/Shanghai; upstream's new push-token-store.postgres.test.ts compares `"expiresAt" > CURRENT_TIMESTAMP` on a timestamp-without-tz column, so all 7 tests failed locally ("Push session ended"). CI's container is UTC. Local fresh DBs now `ALTER DATABASE … SET timezone 'UTC'` (itenv.sh / itenv2.sh) to mirror CI; suite passes 8/8. Deploy note: production Postgres must also run with timezone UTC (postgres image default) or push registration will reject every session — verify `SHOW timezone` before deploying.
- Deploy note: push registrations move from DATA_DIR/push-tokens/*.txt into Postgres (encrypted with existing ENCRYPTION_KEY, which is set on prod). No new env. Existing devices keep working only after `node dist/cli/shared-storage.js push-tokens` (dry-run first) is run with API/worker stopped, or they re-register next time the app opens.
- Semantic notes: token estimation now ~3–4x lower than byte count → our in-run compactor (75% threshold) triggers later, closer to real usage (intended); live-only models whose nearest catalog sibling is another family now get DEFAULT_MODEL_CONTEXT_WINDOW (262144) instead of the sibling's window; chat-completions payload normalization (developer→system role for non-OpenAI reasoning models, merged consecutive user turns, uniqueItems dropped) changes wire shape only, not model selection.
- Follow-up fix (user-approved): hidden background workers had no model → ran on deployment default (deepseek-flash) while main bot used grok-4.7. worker-model.ts resolves the parent's current model at run time (and in resolveModel for history compaction). No DB writes.
- Follow-up fix (user-approved): deployment owner saw no Models/Voice in settings — me.memberSettingsLocked used actor.isDeploymentOwner which upstream #1915 made always false. Now `policy.locked && policy.ownerUserId !== userId`.
- Open (needs decision, not changed): our owner-controls UI (MemberAccessSettings: member lock / share models / Turnstile) depends on `deployment.get` (always FORBIDDEN since #1915) and `deployment.update` (gated on isDeploymentOwner, always false) and web shows it only when me.isDeploymentOwner (always false). So the owner cannot change these from the UI; only env/DB. Restoring needs re-granting owner authority that upstream deliberately removed.

### Upstream merge 0f509715: final verification (2026-10-24 20:40, UTC+8)
- Local: lint/check/intl ok; unit 951 files / 14370 tests passed (80 files DB-gated skipped, as in CI); integration 67/67 suites, 442 tests; build ok; e2e 4 shards 71+68+69+67 = 275 passed, 0 skipped/flaky.
- Pushed fdefda4c..a097a22d (normal push). PR #2 CI run 40093864946 green; image dispatch run 40093895834 green; tag sha-a097a22dbc489713e348b0a803279eeb09212743 (app/computer/updater).
- Not deployed; OTA not published (mobile JS changed: run-error-sheet + locales).

## 2026-10-24 20:39–20:53 (UTC+8) deployed sha-a097a22d to production (user-approved t397u) + OTA
- Pre-check: 0 running/queued runs, computers 2 stopped / 1 suspended / 1 running (none suspending). Prod Postgres `SHOW timezone` = Etc/UTC. DATA_DIR=/data, push-tokens dir has 0 files → push-token move skipped (nothing to move).
- Backups (server UTC ts 20261024-123933): /data/backups/pg-20261024-123933/rakazo.dump (28.1 MB); /opt/rakazo/.env.bak-20261024-123933, docker-compose.images.yml.bak-20261024-123933. Only RAKAZO_IMAGE_TAG changed (same key set). Compose untouched (branch differs only by one comment line). Log /root/deploy-20261024-123933.log.
- Migration applied 20:44:49: 20261023120000_push_tokens (table present, 0 rows). Total 141, 0 unfinished.
- api/worker/web/supervisor on ghcr.io/fgbhhnnn/rakazo/app:sha-a097a22d…, digest sha256:5480aaf652279b1b4cefc5ec5f427f42673cc26772e30f29222a1ac10e6cf7b7 (matches CI run 40093895834); 0 restarts, healthy; site 200, /health 200; web bundle /assets/index-xnfY1jGS.js served from new web container; 0 error log lines (1 csp.violation warn from a browser).
- me/bootstrap (test account): memberSettingsLocked=true, isDeploymentOwner=false. Owner: deployment_settings.ownerUserId=I4CQ…, lockMemberSettings NULL → env RAKAZO_LOCK_MEMBER_SETTINGS=true → lockedForActor(owner)=false (code in shipped dist).
- Smoke (调度测试): docx/pdf → PELICAN / OTTER correct, worker #T8MVG5CZ, 31 s total; echo TKLF7JAW → exact output + exit 0, 9 s; UI: "正在协调后台任务" shown during the task, 0 task cards, 0 old counters.
- Worker model: test parent 调度测试 has no model (modelProvider/modelId null) → worker 后台1 runs and parent runs all deepseek/deepseek-flash (fallback path, matches parent). The parent-has-model path is unit/postgres-tested only; not exercised on prod (would need changing a bot's model).
- OTA runtime 1.0.7 from a097a22d (ios+android): production group d7843703-f679-4821-ad08-afe4ba13080e, preview group 7eb72e69-05b1-42b2-926d-d4a1b2a1b360. ("*" dirty marker = untracked/server-only files; mobile bundle unaffected.)
- Rollback: sha-fdefda4c6715be3dc8a5614347edb5a36aa02f65 (restore .env.bak; migration additive).

## 2026-10-24 21:30 (UTC+8) RAKAZO_ADMIN_EMAILS (commit 5c4f5f76, not deployed)
- New module packages/db/src/deployment-admin.ts: RAKAZO_ADMIN_EMAILS (comma-separated, case-insensitive).
- Env set: listed admins => isDeploymentOwner, deployment.get/update, exempt from member lock, shared-model/voice owner (when ownerUserId null, first listed admin with an account).
- Env unset: member lock / shared scope fall back to deployment_settings.ownerUserId; server administration (deployment.get/update, isDeploymentOwner) stays denied as before (upstream tests require stored owner gets no server authority).
- Local CI: lint, check, intl, unit (mobile api.test only failed due to leaked EXPO_PUBLIC_API_URL from OTA shell; rerun 2120/2120), host-safeguards, integration 67 suites/442, build, e2e 4/4 shards (71+68+69+67).
- Proposed prod env: RAKAZO_ADMIN_EMAILS=cxy081517@gmail.com (+ compose line `RAKAZO_ADMIN_EMAILS:` in /opt/rakazo/docker-compose.images.yml at deploy).

## 2026-10-24 21:51–21:57 (UTC+8) deployed sha-5c4f5f76 + RAKAZO_ADMIN_EMAILS
- Backup /data/backups/pg-20261024-135151/rakazo.dump (28.4 MB); .env.bak-20261024-135151; docker-compose.images.yml.bak-20261024-135151; log /root/deploy-20261024-135151.log.
- .env diff: RAKAZO_IMAGE_TAG changed, RAKAZO_ADMIN_EMAILS added. compose diff: +`  RAKAZO_ADMIN_EMAILS:` after RAKAZO_SHARE_OWNER_MODELS. config -q OK.
- Digest sha256:47fed33ddfaa60e05784f41e0422458021cb56d45de161a5a6e83b304edcb8fd = publish run 40097504451 manifest. No new migrations (141). Health ok, 200/200, bundle index-CvcnO7fR.js, logs 0 errors.
- api+worker RAKAZO_ADMIN_EMAILS=cxy081517@gmail.com; shipped isDeploymentAdmin: owner true (any case), test false. Test acct me: locked=true owner=false, deployment.get 403. echo ADM50101 ok (#TO1MOZ3E, 22 s).
- Rollback: sha-a097a22dbc489713e348b0a803279eeb09212743 + restore .bak-20261024-135151 files.

## 2026-10-24 23:30 (UTC+8) — workers never nest agents (commit 65c109f0, not deployed)
- New `packages/adapters/src/worker-nesting.ts`: hidden workers (bg-worker:*) get run_subagent, background_task*, spawn_bot, handoff_to_bot, message_bot, message_agent, create_child_routine withheld at run time (hook in applyDispatcherToolPolicy) and refused in executor dispatchTool with "Background workers cannot start sub-tasks… Do this work yourself…". run_subagent also added to WORKER_ALWAYS_DISABLED and removed from researcher/coder/media profiles; WORKER_INSTRUCTIONS tell the worker to batch the work itself. cloud_agent_* deliberately kept (dispatcher has no cloud-agent tool).
- Tests: worker-nesting.test.ts (6) + executor-readonly-approval.test.ts "hidden background workers never nest agents" (10). Local: lint 0 errors, check 22/22, vitest 954 files / 14400 passed. Local postgres 65/67; push-token-store + bootstrap-owner fail identically on the unchanged baseline (box env); CI Postgres journeys green.
- CI https://github.com/fgbhhnnn/rakazo/actions/runs/40106231619 green; image publish (workflow_dispatch) https://github.com/fgbhhnnn/rakazo/actions/runs/40106285831 green → ghcr.io/fgbhhnnn/rakazo/app:sha-65c109f037cc4c2d6dae8a9e049407f3b6a59815. Server-only, no OTA.

## 2026-10-24 23:36 (UTC+8) deployed sha-65c109f0 (worker nesting ban) to production (user-approved), no OTA
- Pre-check: 0 non-terminal runs; computers 1 running (idle), 1 suspended, 2 stopped, none suspending/booting.
- Backups (server UTC ts 20261024-153619): /data/backups/pg-20261024-153619/rakazo.dump (32.5 MB); /opt/rakazo/.env.bak-20261024-153619; docker-compose.images.yml.bak-20261024-153619. Log /root/deploy-20261024-153619.log.
- .env: only RAKAZO_IMAGE_TAG changed (same key set, 2 diff lines). RAKAZO_ADMIN_EMAILS set in api and worker.
- Verify: api/worker/web/supervisor on app@sha256:bf551a512e4db115f4486c228b644183db5a76df45f484cc618e33894a0d9ec6; 141 migrations, none pending/unfinished; api+supervisor healthy, internal /health 200; site 200; bundle /assets/index-Du0y4A9b.js 200; 0 error-level log lines in 10 min; refusal string present in dist.
- Rollback: cp .env.bak-20261024-153619 .env (and compose .bak) then compose pull && up -d (back to sha-5c4f5f76).

## 2026-10-25 00:45 (UTC+8) — Grok Bot–style dispatcher A–D + ask_user (commit e9e20fdf, not deployed)
- ask_user: dispatcher text published before pause (bug: pre-ask text was lost); worker report attachments relayed idempotently (bug: duplicates). Guidance in dispatcher-ask-guidance.ts.
- A owner tools on dispatcher (dispatcher-owner-tools.ts): spawn/update/archive_bot, fleet, schedule_*, call_user, connect_app, request_secret/secret_request/list_secrets/forget_secret, add_mcp_server, propose_instructions_update, create_space; request_takeover excluded (needs computer).
- B workers: user-facing tools withheld + refused (worker-user-facing-tools.ts); secret_request deliberately kept (no card; needed for saved creds). Heavy Task skill: workers poll in-turn, no reminders.
- C workers use main bot's memory/scratchpad/secrets/MCP/taught skills (worker-owner-scope.ts) and inherit main instructions + disabled tools (worker-main-settings.ts). Worker writes go to owner scope; thread-history recall stays on worker id.
- D worker approval pause → status needs_user + card/text in main chat linking to worker chat (worker-needs-user.ts). Full approval-card mirroring not done.
- Local: lint/check green, vitest 14424 passed, postgres all pass except baseline push-token-store.
- CI https://github.com/fgbhhnnn/rakazo/actions/runs/40110423634 green; image https://github.com/fgbhhnnn/rakazo/actions/runs/40111131008 green → ghcr.io/fgbhhnnn/rakazo/app:sha-e9e20fdfe7a8fbba27d0a32b91c1165dc1455cdf. Server-only, no OTA.

## 2026-10-25 01:40 (UTC+8) worker approval cards answerable in the main chat (commit 3e9bdc1b, not deployed)
- Hidden worker pausing on an approval → copy of the ask block posted in the main chat (runId null, + workerApproval {runId, messageId, label "任务 #REF（name）"}); old '点开处理' child_bot card removed.
- Answer on the copy → apps/api worker-approval-answer.ts: run-user only (FORBIDDEN), open + same worker run (else CONFLICT), then the normal answerRunInput on the worker thread; commitAnswerRunInput settles every copy in the same tx (idempotent: thread lock, waiting_input, effect intended). Worker-chat answers settle the copy too.
- Worker ended: finalizeBackgroundTaskAfterReturn closes copies (cancelled → "Cancelled", else "No longer active"); a late answer closes it lazily.
- Bug caught by postgres test: message blocks are sealed at rest (only kind/status queryable), so lookups use array_contains [{kind:"ask"}] and filter the opened blocks.
- Local CI on the committed tree: lint, intl extract (no diff), check (incl. mobile), unit 960 files/14436 passed, host-safeguards 26, build, integration 69 suites (only local baseline push-token-store fails), e2e 71+68+69+67=275 (shard 2 first run: 2 onboarding timeouts, rerun 68/68 green).
- CI https://github.com/fgbhhnnn/rakazo/actions/runs/40116228096 green. Mobile JS changed → OTA needed (runtime 1.0.7 unchanged); not published.
- Image publish https://github.com/fgbhhnnn/rakazo/actions/runs/40117014426 green → ghcr.io/fgbhhnnn/rakazo/app:sha-3e9bdc1b6115e3a4a08c08409c91425b5a381e73.

## 2026-10-25 07:02–07:04 (UTC+8) deployed sha-3e9bdc1b (worker approvals answerable in main chat) to production (user-approved)
- Pre-check: CI 40116228096 + image run 40117014426 success; ghcr tag digest sha256:9546f252…; 0 running/queued runs; 1 waiting_input (TBEJ0V1H, see below); computers 1 running, 1 suspended, 2 stopped, none suspending/booting.
- Backups (server UTC ts 20261024-230259): /data/backups/pg-20261024-230259/rakazo.dump (33.7 MB); /opt/rakazo/.env.bak-20261024-230259; docker-compose.images.yml.bak-20261024-230259. Log /root/deploy-20261024-230259.log. Only RAKAZO_IMAGE_TAG changed (same key set, 2 diff lines).
- Verify: all 4 services on app@sha256:9546f25258f5cdf1612738dca9319d09d6ec139078ea58298a89ffb902c23ad7 (matches publish run log), 0 restarts, healthy; 141 migrations, 0 unfinished; /health 200; site 200; /assets/index-CItjlWWH.js contains worker-approval-label; 0 error lines in first minutes; RAKAZO_ADMIN_EMAILS set in .env, compose, api, worker.
- Rollback: cp .env.bak-20261024-230259 .env; cp docker-compose.images.yml.bak-20261024-230259 docker-compose.images.yml; compose pull && up -d (→ sha-65c109f0).

## 2026-10-25 07:05 (UTC+8) ISSUE: real bot 大道出海whatsapp worker #TBEJ0V1H stuck on invisible approval (read-only finding)
- Task cmvmnbej2005e07m8jf6i0hcg "模拟器跑 rakazo", status started, created 01:01:21 UTC+8. Worker bot 大道出海whatsapp · 后台1 (cmvmh089b2a31tmsoguusgyyd), run cmvmnbenm005g07m84xrd4w2o waiting_input since 02:03:30 UTC+8; thread cmvmh08ae000j07lcrv0wz5cq seq 27 has ask block pending.
- It is waiting on approval of schedule_create (effect cmvmnyq5x007j07m8q5av82rr, status intended, called 01:19:29 UTC+8): a routine "rakazo gradle check" to check the gradle build later, install the APK on emulator-5554, take a screenshot, then shut down the emulator.
- E2B computer cmvjbejsp000307qrago3x276 is state=running since 00:43:27 UTC+8 (no execution lease), so it is likely still billed.
- Not mirrored: approvals that paused before 3e9bdc1b get no mirror (no backfill), and the main chat has no pending mirror. WORKER_NEEDS_USER_NOTE tells the main bot "its approval card is already shown in this chat", which is false for this legacy case.

## 2026-10-25 07:13–07:50 (UTC+8) — cancel TBEJ0V1H, OTA 1.0.7, test-account tests (sha-3e9bdc1b)
- Cancel #TBEJ0V1H (user-approved 07:13) via cancelBackgroundTask in container, 07:17:09 UTC+8: task cancelled, run cmvmnbenm cancelled (run.cancelled seq 5424). Computer cmvjbejsp000307qrago3x276 left RUNNING (untouched). schedule_create not approved; effect cmvmnyq5x stays 'intended', stored ask block stays 'pending' (not answerable; run is cancelled).
- OTA production 07:17:54–07:19:52 group 8e50b8ad-68d1-49b6-9014-53c5e6ab1176; preview 07:19:52–07:21:46 group d0f20fa7-3438-4eff-96c0-4e740210bbec. runtime 1.0.7, commit 3e9bdc1b. EXPO_PUBLIC_* unset.
- (a) main-bot ask_user card: PASS (choice-2 stored, 2nd answer 409, reply COLOR=蓝色).
- (b) worker approval mirrored to main chat: allow #TG5LEXFC PASS (concurrent double answer → 1 ok / 1 409, effect ran once, run completed); deny #THGEO7IQ PASS.
- (c) fleet list/organize_bot pin+unpin PASS; schedule_create/list/cancel PASS; worker #TPF7X9W7 tool list has no request_secret/connect_app/ask_user (secret_request present by design, no card) PASS. The direct "worker tries request_secret" version was blocked by Auto-review and was not run.
- ISSUE: background_task_cancel doesn't close the worker-approval mirror (stayed open 180 s; only a later answer → 409 + closed=cancelled) (#TIB3DMU8). Same gap leaves cancelled-run ask blocks 'pending' and effects 'intended'.
- ISSUE: require_approval rule on web_fetch never produces a card (web_fetch is in READ_ONLY_AGENT_TOOLS).
- ISSUE: test account's media worker lacks generate_image.
- Minor: worker calls a render_plot tool error "被拒绝" after an allow; main-bot note says cards exist for pre-deploy (legacy) approvals, but there is no backfill.
- ISSUE: computer.sleep jobs for cmvjbejsp exhausted (25/25, "not running and has been resumed"/"fetch failed"); E2B computer billing since 00:43 UTC+8.
- Test rule cmvn1fz3q (render_plot) removed after tests.

## 2026-10-25 09:40 (UTC+8) A worker activity in status + B report_progress (commits bbfa0c17 + a402efd3, not deployed)
- A (worker-activity.ts): background_task_status for a started task adds current_call {tool, summary, started_at, running_for_s}, recent_activity (last 6 calls: tool, redacted ≤160-char activity line, outcome, duration_s, at), last_event_at, from the run's existing agent.tool.called/completed + activity thread.progress events (FIFO pairing, by executionId). Tool description + status note: answer "where is it at" only from these fields, say plainly when a call runs long / nothing happened.
- B (worker-progress.ts): report_progress(text) hidden workers only; ≤280 chars, redactSecrets(runSecrets)+redactSensitiveText; ≥2 min between notes per run (too early → {ok:false, too_soon:true, retry_after_s}, not an error; per-run in-process lock so parallel calls can't both pass). Saved as thread.progress {activity, notice:"worker_progress", note} in the worker's own thread → status last_progress/last_progress_at. No wake, nothing in main chat. Withheld from main/regular bots (dispatcher-mode hook; regular-bot call → "This tool is disabled for this bot."), kept through profile allowlists (worker-tool-policy). WORKER_INSTRUCTIONS: milestones-only line; first bullet now says the main bot sees recent calls + notes.
- Finding: thread.progress rows are deleted at finalize/pause (events.ts), so notes and activity lines exist only while the run is running; after a pause (needs_user) status shows calls without summaries and no note. Fine for "where is it at" on running tasks.
- Local: lint 0 errors, check 22/22, vitest 962 files / 14452 passed; postgres/journeys 71/71 (push-token-store only passes on a UTC DB, box env as before). New: worker-activity.test.ts (5), worker-progress.test.ts (9), worker-progress.postgres.test.ts (sealed note, rate limit, main-bot refusal, status fields), executor-readonly-approval +2 (offered + saved for worker; disabled for regular bot), worker-nesting regular-bot assertion now exact ["report_progress"].
- CI issue: Postgres journeys job hit its 10-min cap twice (attempts 1+2 of run 40149567811; all 68 suites that ran passed incl. the new one; prior green run already took 9m56s). Fix a402efd3: timeout-minutes 10→15 for that job only.

- 2026-10-25 09:55 (UTC+8) CI + image for a402efd3: ci https://github.com/fgbhhnnn/rakazo/actions/runs/40151227762 green (Postgres journeys passed within the new 15-min limit; all E2E/unit/typecheck/lint/native jobs green). Image published via workflow_dispatch https://github.com/fgbhhnnn/rakazo/actions/runs/40151939628 -> ghcr.io/fgbhhnnn/rakazo/app:sha-a402efd337577251e4a5835644866b1fd160310a (digest sha256:d13eede688f76c4d019aa8baed9726efe141bfd8928895e7010f134a2e357905), plus computer/updater images. NOT deployed; no OTA. Test-account check pending a deploy.

## 2026-10-25 10:07–10:08 (UTC+8) deployed sha-a402efd3 (A worker activity + B report_progress) to production (user-approved 09:57), no OTA
- Pre-check: CI 40151227762 + publish 40151939628 success; ghcr digest sha256:d13eede688f76c4d019aa8baed9726efe141bfd8928895e7010f134a2e357905. #T7932RWW completed 08:55 (UTC+8) per background_task_queue (not touched). 0 non-terminal runs. Real computer cmvjbejsp was `suspending` (idle computer.sleep job 2774 locked since 09:05:30); waited, it ended 10:06 (state running, job gone) without us touching it; then deployed (1 running, 1 suspended, 2 stopped).
- Note: the first launch (TS 20261025-020638) stopped after pg_dump because `ssh bash -s` + `compose exec` consumed the script's stdin; only an extra dump /data/backups/pg-20261025-020638/rakazo.dump was written, nothing changed. Re-ran as a file with </dev/null.
- Backups (server UTC ts 20261025-020709): /data/backups/pg-20261025-020709/rakazo.dump (34.4 MB); /opt/rakazo/.env.bak-20261025-020709; docker-compose.images.yml.bak-20261025-020709. Only RAKAZO_IMAGE_TAG changed (same key set, 2 diff lines); compose untouched. Log /root/deploy-20261025-020709.log.
- Verify: api/worker/web/supervisor all on sha256:d13eede6…, 0 restarts, healthy; 141 migrations, 0 unfinished (no new migration); site 200, /health 200; 0 error lines (first ~8 min); RAKAZO_ADMIN_EMAILS present in .env, compose, api, worker; dist contains report_progress.
- Rollback: cp .env.bak-20261025-020709 .env; cp docker-compose.images.yml.bak-20261025-020709 docker-compose.images.yml; compose pull && up -d (→ sha-3e9bdc1b). No DB restore.

### Test-account tests (调度测试 main bot, concurrency 1–2) 10:09–10:15 (UTC+8) — script /workspace/rakazo/ds4/
- Task #TWT8SP73 "RPT1 多步测试": 6 shell steps of sleep 40, report_progress after step 2, 3 (rate-limit probe), 5. Completed 10:14:18, RPT1_DONE S1..S6, all exit 0.
- (1) PASS. "在哪一步" asked 10:11:34 → main bot called background_task_status and answered: step1 43 s, step2 40 s, progress "已完成 2/6 步" 10:11:24, step3 running ~15 s since 10:11:25 — all match the events (called/completed 10:09:57→10:10:40, 10:10:42→10:11:22, 10:11:25). It said it doesn't know outputs yet (honest). Raw fields at 10:13:01: current_call shell "Running: sleep 40; echo RPT-S5" started 10:12:52 running_for_s 14; recent_activity 6 items (S2 40 s, report_progress 0 s, S3 41 s, report_progress 0 s, S4 40 s, S5 running), last_event_at 10:12:52.
- (2) PASS. Note 1 stored as a worker_progress thread.progress event (10:11:24) and shown as last_progress; 2nd call 10:12:08 stored nothing, last_progress unchanged, tool outcome succeeded (gentle too_soon, not error), worker did not retry; 3rd call 10:13:34 (>2 min) succeeded per worker. Main chat got only the replies to my own questions and the final result — nothing posted by report_progress, no auto-wake.
- (3) PASS. Main bot 调度测试 and normal bot New Bot tool lists have no report_progress (HAS_REPORT_PROGRESS=no); the worker had it.
- Minor: the report_progress activity summary is generic ("Using report_progress"), not the note text (note text is in last_progress). Progress rows deleted at run end as designed, so finished tasks show no notes.
- Cleanup: no rules/tasks created besides the test task (completed); 0 non-terminal runs/tasks after. Test computer cmvk9w1km booted for the test (will idle-sleep normally).

## 2026-10-25 10:40 (UTC+8) upstream 15 commits (c5e66e01..e7674251) — STOPPED, nothing pushed
- Cherry-pick -x in order: a1a4de59, 822b8797 clean; 64ffaa4f CONFLICT in apps/web/src/pages/Shell.tsx + shell/transcript.tsx — it re-does the chat header/bubble layout introduced by postponed c5e66e01 (#2043, web-only "Cap chat bubble width", incl. bubbleFrameWidth). Per brief: stopped; did not pull in c5e66e01.
- feat/heavy-task-robustness reset to a402efd3 (= origin, the two local unpushed picks dropped). Scratch branch probe/upstream-15 (local only) holds the dry-run.
- Probe (skip on conflict): 6bb83ed9 CONFLICT apps/mobile/app/thread.tsx (built on postponed 3fb98491 "float chat header on iOS", which removed the Connection/Routine mention code) + packages/chat-ui/src/markdown.test.ts (our trusted-image-host tests vs withMentions tests; keep both). a1887b85 and e321dd67 conflict only with our code in packages/adapters/src/executor.ts (+ apps/api/src/thread-target.ts) — resolvable, not dependency. The other 11 apply cleanly and `pnpm check` 22/22 passes on them.
- c9bac278 removes none of our added lines (our files touched: golden.spec.ts, message-hover-actions.spec.ts — only upstream lines removed).
- c436c7f1: migration 20261024180000_skip_approvals_preference (additive column action_auto_review_preferences.skipApprovals default false). Preference is keyed by run.userId, so hidden workers inherit the owner's switch: ordinary approvals → planActionGate "allow" → no needs_user → no mirror card (consistent). Mandatory approvals (fleet, cross-owner, unattended shell watch, webhook writes) and the owner's own ask-before rules still ask → mirror still used. No code change needed for the mirror.

## 2026-10-25 10:26–11:05 (UTC+8) merge upstream/main e7674251 (all 25 commits) → b4b1895d (pushed, not deployed, no OTA/EAS)
- Single `git merge upstream/main` on a402efd3 (no cherry-picks kept; probe/upstream-15 + tag pre-upstream-15 local only). Merge commit b4b1895d5c386cb9f49a8d6b2c3379d7ae107ab4.
- Conflicts resolved: thread-target.ts (kept our stopThreadRunsForBots; upstream's run-secret deletion on stop ported into our packages/adapters/src/thread-stop.ts), executor.ts (upstream loadLoginPasswordRedactions now uses secretScope so hidden workers hide the owner's login passwords they fill), mobile voice.ts + call-card-keep-awake.test.tsx, chat-ui markdown.test.ts, web Shell.tsx (unions). No line we added was lost (scripted check over all changed files; only structural tokens/intentional select widening).
- Logic interactions: (1) skipApprovals keyed by run.userId → workers inherit it; ordinary approvals allow → no needs_user/mirror; mandatory/unattended/explicit-ask still ask + mirror. (2) c9bac278 removes none of our tests. (3) workers have no request_secret (withheld), so no one-time run secrets; secret_request kept. (4) task cards are child_bot "created" blocks naming the hidden worker; web+mobile strip them (withoutBackgroundTaskCards) before projectBotMentions — new test background-task-mentions.test.ts.
- Router: our worker-mirror lookup runs before upstream's AnswerTooLong mapping; upstream test mock lacked prisma.message → added the same null mock as the neighbouring test (behaviour unchanged).
- Migration added: 20261024180000_skip_approvals_preference (additive column, default false; rollback-safe).
- Version kept 1.0.7 (upstream bumped to 1.0.8; runtimeVersion policy appVersion). Native: only Android rakazo-notifications module (abb40385 call FGS RakazoCallService + startCall/stopCall + FOREGROUND_SERVICE_MICROPHONE/WAKE_LOCK; 007991ef locale arg on setSettings/resume + localized strings). No iOS/dep/plugin changes. Expo Kotlin bridge throws "Received 5 arguments, but 4 was expected" → added JS shim native-arity-compat.ts (retry 4-arg form on exactly that error) + call-background guard (no startCall → false → keep-awake fallback). Test native-1-0-7-compat.test.ts.
- Local CI on b4b1895d: install ok, lint 0 errors, check 22/22, vitest 974 files / 14730 passed, postgres/journeys 71/71 + push-token-store on UTC DB.
- GitHub CI on b4b1895d: ci https://github.com/fgbhhnnn/rakazo/actions/runs/40156368627 success (plus Computer runtime 40156368706, desktop-macos-screenshot 40156368649, PR publish-server-image 40156368635 all success). Image via workflow_dispatch https://github.com/fgbhhnnn/rakazo/actions/runs/40156976431 success → ghcr.io/fgbhhnnn/rakazo/app:sha-b4b1895d5c386cb9f49a8d6b2c3379d7ae107ab4 (app digest sha256:a5ed22b20745608c4d2beecac54d666c14965a03816058c7e965773523a07201) + computer/updater images. NOT deployed; no OTA; no EAS build.

## 2026-10-25 Deploy sha-b4b1895d (upstream merge e7674251) + OTA 1.0.7 — test account (UTC+8)
- Deploy 11:20:15–11:21:31. TS=20261025-032015 (server UTC). Backups: /data/backups/pg-20261025-032015/rakazo.dump (34,877,007 B), /opt/rakazo/.env.bak-20261025-032015, /opt/rakazo/docker-compose.images.yml.bak-20261025-032015. Log /root/deploy-20261025-032015.log.
- api/worker/web/supervisor on sha256:a5ed22b20745608c4d2beecac54d666c14965a03816058c7e965773523a07201, 0 restarts; migrations 142, 0 unfinished (new one finished 11:21:13); site + /health 200; 0 error log lines since deploy.
- OTA runtime 1.0.7 android+ios: production 11:32:36–11:34:18 group 9aad1bc6-ba13-4dab-b472-cd70834fee2c; preview 11:34:18–11:35:59 group 60e078e9-1e4f-44b7-89ff-a7b08201fa76. No EAS build.
- (1a) ask_user card PASS (answer, 2nd answer 409, reply COLOR=蓝色). (1b) worker approval mirrored to main chat PASS (render_plot rule card on #T2IR1TU2, concurrent double answer 1 ok/1 409, task finished). (1c) background_task_status recent_activity + report_progress PASS.
- (2) skipApprovals exists, default false, never changed. Rule-based approval asks with it off (1b). NOTE: forget_secret (default path, no rule) ran without a card: planActionGate returns allow for default-path consequential tools unless Auto Review checker is configured (checkerAvailable=false here). Same code pre-merge (a402efd3) → not a regression, but means "ordinary" approvals on this deployment only = explicit rules + new fetch destinations.
- (3) Hidden worker names PASS: main chat 100 msgs, 11 task cards for hidden worker cmvkqu4et…; unfiltered projectBotMentions would give 11 worker mentions, with withoutBackgroundTaskCards 0; browser body shows no worker name/card text; bots/list shows only the 2 visible bots.
- (4) Login-password redaction live test SKIPPED: Auto-review blocked sending a password-shaped value to the bot; covered only by CI unit tests (executor-login-redaction).
- (5) Smoke PASS: /app 200, composer in 4.1 s, chat renders, Usage panel shows per-model table (deepseek-flash 1,447 calls, grok-4.7 847), 0 page errors. Minor: Tokens/Input/Output/Cost show "—" because new upstream completeSums marks totals unknown if any row lacks counts (8 old deepseek rows, 57 old grok rows have null tokens; grok-4.7 cost never recorded). Display behaviour, not a deploy fault.
- Cleanup: temp rule removed (rules []), no bot secrets, 0 non-terminal runs on test account, skipApprovals=false.
- Rollback: cd /opt/rakazo; cp .env.bak-20261025-032015 .env; cp docker-compose.images.yml.bak-20261025-032015 docker-compose.images.yml; compose pull && up -d (→ sha-a402efd3); no DB restore (migration additive).

## 2026-10-25 12:01 UTC+8 — skip-approvals ON for real account cxy081517@gmail.com (user request pt456u)
- Storage: action_auto_review_preferences.skipApprovals, per (spaceId, userId) (migration 20261024180000). User has 1 space: Personal 7337fe099c4a97a1983e240ffaf7bc93. No row existed before (effective false).
- Path: router autoReview.set (apps/api/src/router.ts ~6609, prisma upsert) called via @orpc/server call() with the user's actor in rakazo-api-1 (/app/node_modules/.bin/tsx). Input {skipApprovals:true} only (same as UI). Before {enabled:true, checkerAvailable:true, skipApprovals:false} → after {enabled:true, checkerAvailable:true, skipApprovals:true} at 12:01:19.543 UTC+8. DB row: enabled=t, skipApprovals=t, updatedAt 12:01:19.569 UTC+8. Temp script removed from container (/app/apps/api/skip-on.tmp.ts), host /root and box /tmp.
- Note: security_events audit row NOT persisted (script didn't configure the event store; logged to stdout only). Test account has no pref row (still false). No bots/models/rules touched.
- User's rules: 14 always_allow (9 site, 5 tool), 0 require_approval.
- Still ask with it ON: explicit "Ask before" rules (none exist); fleet/child changes (create_group, update_group, set_child_instructions, set_child_bot_model, create_child_routine); cross-owner connection (respond_agent_connection); propose_instructions_update when outside content entered the run; schedule_create with a command watch; schedule_create naming a new site in a tainted run; any non-read tool in webhook-triggered runs. New-site fetches and default/Auto-Review path no longer ask.
- UI: web Settings (设置) → Confirmations → "Run actions without asking" (无需询问直接执行操作), testid skip-approvals-toggle; mobile Settings → Account → Advanced (高级) → same label.

## 2026-10-25 14:00 UTC+8 — Computer health feature (commit db163c2e, PR #2, not deployed)
- Local CI all green: pnpm lint, intl catalog check, db:generate + pnpm check (22/22 incl. mobile), pnpm build, desktop build + native-computer vitest (6 files), host-safeguards.test.py (26), pnpm test (976 files / 14,749 tests pass; 87 DB-gated files skip as in CI's unit job).
- Integration: box has no Docker, so testcontainers can't start. Ran /tmp/integ-local.sh, a mirror of harness.ts --integration on local Postgres (same env, one migrated template DB cloned per suite, UTC): 74/74 suites PASS, incl. new computer-health.postgres, computer-restart-answer.postgres, row-security.postgres.
- Gotcha: running `pnpm test` with itenv2 vars still exported (VERIFY_DATABASE/DATABASE_URL) makes the DB-gated suites run in parallel on one DB → 69 spurious failures (unscoped-access guard, mock tx). Always run unit tests with those vars unset.
- Fixes found by tests: fixture scope must be team|dedicated; restart card detail needed detailFormat "text" (else rendered as grey code block); fresh "suspending" claim now enqueues one look-back job at claim+30 min (holder crash would otherwise leave it stuck until next use).
- Upgrade-postgres docker test and Electron smoke not run locally (no Docker / no display; untouched areas) — left to GitHub CI.

## 2026-10-25 14:40 UTC+8 — Prod "stuck on 处理中" (dispatcher setup timeout), same branch feat/heavy-task-robustness

Root causes (read-only prod logs/rows, run cmvnev9zk… and cmvnezpkp… on 大道出海whatsapp; nothing written):
- (a) The 90 s dispatcher reply watchdog starts before setup. Setup awaited Composio connector tool discovery and the live
  plugin listing (Composio returned 500 "Failed to fetch API key information from DB" / was slow). The watchdog fired during
  setup; the before-model check then saw the aborted signal and returned quietly → run stayed 'running' under our lease
  with no job until the 5 min lease expired (attempts 05:54:30→05:59:39 and 05:56:05→06:02:06 UTC, both "interrupted", no error).
  Dispatcher runs discard connector tools anyway, so the wait was pure waste.
- (b) Steering does not abort (pi agent.steer queues for the next model turn). The failure at exactly 90 s
  (06:04:31.8→06:06:01.9 UTC) was the watchdog; pi reports any signal abort as "Request was aborted", which was stored as the
  run error. The steer correctly moved to a follow_up continuation, which then failed on a grok-4.7 provider outage (TransientModelError, not ours).
- (c) Hung computer.sleep job 2782: the unbounded checkpoint (fixed by the Task 1 deadlines + stale 'suspending' recovery).
  These two runs never touched the computer (run.computer reason none; dispatcher turns skip the computer lease).

Fix (packages/adapters/src/executor.ts):
- Dispatcher turns skip connector tool discovery.
- Dispatcher turns cap the live Composio listing at 5 s (DISPATCHER_PLUGIN_LISTING_MAX_MS), then use the stored rows.
- Watchdog fired during setup while we still own the run → DispatcherTurnTimeout → existing finalize + bounded restart
  (max 2) or the truthful "回复超时" message. No more quiet return.
- A watchdog abort mid-stream is recorded as the timeout, not "Request was aborted".
Tests: packages/adapters/src/executor-dispatcher-setup.test.ts (9). 5 of them fail on the old executor (verified), all pass now.

Gotcha: in the mock executor harness, the runtime's abort signal is the 2nd arg (context.signal), not request.signal.
Local CI: lint/check/build OK; unit 977 files / 14758 tests pass (DB env unset); intl clean; integration below.
- 15:45 UTC+8 Transient model error path checked (prod, read-only): cmvnfchzb… failed 06:06:02→06:07:17 UTC (75.5 s), cmvnfgjbe… 67 s,
  cmvnezpkp… attempt 2 59 s — all "Service temporarily unavailable" from grok-4.7, finalized at once (run.failed → job.completed),
  user told "这次回复失败了：…". No lease wait. The only 5 min gap (06:02:06→06:07:06) was bug (a). Added a regression test (10 tests in file).

## 2026-10-25 17:36–17:56 (UTC+8) Deploy sha-c83876ba (computer health + dispatcher stall fixes) + OTA 1.0.7 — user-approved (cards t471s1684 17:16, t472s1694 17:36)
- Pre-check: 0 queued/running/leased runs. cmvjbejsp (大道出海whatsapp, read-only) stuck 'suspending' since 16:56:04, sleep job 2896 locked by the old worker; deployed anyway per user.
- Backups (server TS 20261025T093654Z): /data/backups/pg-20261025T093654Z/rakazo.dump (36,850,119 B, 865 TOC entries), /opt/rakazo/.env.bak-20261025T093654Z, /opt/rakazo/docker-compose.images.yml.bak-20261025T093654Z.
- .env diff = RAKAZO_IMAGE_TAG only. up -d 17:37:57; api/worker/supervisor healthy, web up, all on sha-c83876ba; migration 20261025060000_computer_health finished 17:38:45; site + /health 200; 0 error log lines since deploy.
- OTA runtime 1.0.7 android+ios, commit c83876ba: production 17:40:47–17:42:41 group cdbac2d5-fb05-474c-97ef-14f56ff8cd06; preview 17:42:41–17:44:32 group 4b7da07d-cc9d-4f10-b8fc-bc9e8569eedc. EXPO_PUBLIC_* unset after.
- Test account (bot 调度测试 cmvkqqzxd…): (1) plain dispatcher reply in 11.9 s PASS. (2) worker task #T6XL1C3M woke suspended computer, ran commands, result (42, df line) at 38 s PASS.
- NOTE: graphile keeps job 2896 locked by the dead worker pool until its 4 h lock expiry (~20:56 UTC+8); cmvjbejsp recovers then (new code: claim >30 min stale) or on next worker use. No manual touch.

## 2026-10-25 18:05–18:35 (UTC+8) Broad user-behaviour test on sha-c83876ba (test account ccxxyy0815@gmail.com, bot 调度测试 cmvkqqzxd…, sequential, concurrency 1)

| Area | Case | Result | First reply | Final result |
|---|---|---|---|---|
| Conversation | 4 turns, remembers "青绿色" | PASS | 16.8/16.7/13.0/9.1 s | – |
| Code | worker writes and runs primes.py (#T0B8JLQV) | PASS, 25 primes, sum 1060, file attached | 24 s | 66 s |
| File CSV | 180-row sales.csv → per-region totals + summary.xlsx (#T2CWCH9K) | PASS, totals exact (华东 40770 / 华南 38512.5 / 华北 36020) | 24 s | 127 s |
| File PDF | summarize report.pdf, find code word (#T4YHB4BO) | PASS (PERSIMMON) | 20 s | 43 s |
| Image describe | shapes.png | PASS (red square, blue circle, text) | 12.5 s | 12.5 s |
| Image edit | grayscale + add "已处理" → shapes_gray.png (#T6KG4L03) | PASS, file attached, R=G=B verified | 27.5 s | 148.5 s |
| Image generate | watercolor cat (#T9WA1AAF) | FAIL (config): no generate_image tool | 34.7 s | 54 s (honest failure) |
| Tool web search | Python latest stable + source (#TBGGMBVB) | PASS (3.15.1, python.org links) | 20 s | 55 s |
| Tool web fetch | example.com title + first paragraph (#TCMHFD81) | PASS | 24 s | 39 s |
| Tool shell | uname/python3/df (#TDE8GKUM) | PASS, exit 0 | 20 s | 35.5 s |
| Background process | nohup sleep 1500 (#TEGDSD2H) | PASS, PID 166400 | 24 s | 39 s |
| Long command | sleep 690 in one shell call (#TPSZLKL9) | LIMITATION: exit 124 at the 300 s shell cap, reported truthfully | – | ~10 min |

No stuck 处理中, no hung runs. After the deploy: 48 runs completed, 0 failed, 0 cancelled; 0 error/fatal log lines.

### Issues
1. **Image generation not available on this self-host (config, not code).** No MEDIA_GENERATION_* vars in /opt/rakazo/.env or in the worker env, so createMediaGenerationProvider() returns undefined and generate_image is filtered out. Enabling it needs MEDIA_GENERATION_PROVIDER=fal + MEDIA_GENERATION_API_KEY + MEDIA_GENERATION_IMAGE_MODEL (new secret → owner decision).
   - Minor UX: the dispatcher still said "我来生成" and delegated before the worker found out it has no tool.
2. **Worker shell call cap ≈300 s** (exit 124). A single long foreground command can't exceed it; long jobs must use nohup/background + polling. The bot handled it honestly. Not a deploy regression.
3. Dispatch overhead: the first acknowledgement for delegated tasks takes ~20–28 s, and plain dispatcher replies take 9–17 s. Acceptable, but this is the main latency users feel.
4. computer_health stays empty unless the computer is held (an active run or background process) at sleep-check time, or a responsiveness failure occurs. That's expected by design.

### 18:21 (UTC+8) model change: user deleted deepseek-flash (grok only)
- Test bots (调度测试 + 4 workers) have no pinned model (modelProvider/modelId empty) → they follow the default.
- Run history: deepseek-flash 552 runs, last one 2026-10-24 20:48 UTC+8. grok-4.7 has served every run since then, so all of today's tests already ran on grok-4.7.
- First chat after the deletion (18:22:14 UTC+8): openai-compatible/grok-4.7, completed, 9.0 s. No error, no odd fallback, no stuck run.

### 18:29 (UTC+8) computer_health observed on the new code
- Test computer cmvk9w1km held by a background `sleep 1500` (PID 166400). Sleep job 2898 ran at 18:29:36 and completed ok in 2.5 s. computer_health row written at 18:29:38: disk 21%, memory 9%, failures 0, no alert. The computer stayed running (not put to sleep with a live process), and the next check is queued as job 2915 at 18:39:38.
- The background process ends by itself at about 18:44, then the computer should sleep at the following check.
- cmvjbejsp000307qrago3x276 at 18:31: still 'suspending' (since 16:56:04). Job 2896 is still locked by the dead old pool (attempts 1). Expected self-recovery at about 20:56 UTC+8 (4 h lock expiry → re-run on the new code → stale-suspending recovery). Not touched.
- Prod error/fatal log lines in the last 60 min: 0.

## 2026-10-25 20:07–21:00 (UTC+8) Deploy sha-8579ea5e (merge of 12 upstream commits) + OTA 1.0.7 + iOS 1.0.8 build
- The image CI run 40190055047 was a pull_request validation only (publish skipped), so the sha-8579… images were missing on ghcr. Published them via workflow_dispatch run 40191950316 (same as earlier deploys); app/computer/updater all OK.
- Deploy script stumble: piping the script over `ssh bash -s` let `docker compose exec` swallow the rest of stdin after pg_dump. No change was made (tag unchanged). Re-ran as a file with </dev/null → fine. The stray first dump /data/backups/pg-20261025-122337/ is left in place (harmless, not pruned).
- Backups: /data/backups/pg-20261025-122414/rakazo.dump (37,629,639 B, 874 TOC lines), /opt/rakazo/.env.bak-20261025-122414, /opt/rakazo/docker-compose.images.yml.bak-20261025-122414.
- up -d ~20:30:53–20:31:36. Migrations 20261024150000_model_roles + 20261025120000_model_connections finished 20:31:19. 145 total, 0 unfinished. api/worker/supervisor healthy, web up, 0 restarts, 0 error lines. Site and /healthz return 200.
- Model config: connection, preference and bot model columns are byte-identical to the pre-deploy snapshot (and the backup dump). Exactly 1 role row: main/0 = openai-compatible/grok-4.7, bound to the existing connection. All post-deploy runs use openai-compatible/grok-4.7.
- Finding (not changed): hidden worker "deepseek · 后台1" (cmvlu7xpp…) is still pinned to deepseek/deepseek-flash, which the user deleted. It would fail or fall back if it ever runs.
- OTA runtime 1.0.7: production 8c23dc00-be43-497f-9c61-8839ae3ad1e7 (20:33–20:35), preview 5f59b169-956d-4a02-8828-d6482c301e3b (20:35–20:38).
- iOS: native changes vs the 1.0.7 store binary (98e050511): rakazo-fold-regions Swift module, expo-asset, expo-notifications 57.0.23→57.0.24 → bumped to 1.0.8 (commit fd2c9155, local lint/check/test + pg green, GitHub CI green). EAS build ff1fb11d-5c23-41f6-b1ac-1badc53008a4, ios-testflight, buildNumber 6.
- Tests (test account, sequential): chat memory 13.8/14.2 s PASS; code fib.py 20 s/52 s + file PASS; CSV totals 29 s/67 s exact PASS; image describe 12.5 s PASS; web fetch 28 s/43 s PASS.
- cmvjbejsp: recovered at 20:38:01. A run of the user's "wp建站 · 后台1" worker requested it (reason tool) → provisioned on the new code from the stale 'suspending' state, now 'running'. The old locked job 2896 was replaced by a normal sleep job 2919. Not touched by me.
- iOS build #1 ff1fb11d (fd2c9155) ERRORED: "UIWindow has no member reservedRegions". The rakazo-fold-regions module needs the iOS 27.1 SDK. The fork's ios-testflight profile pinned macos-tahoe-26.5-xcode-26.6 (copied from production on 10-23, before upstream moved production/preview to macos-tahoe-26.6-xcode-27.1). Fixed in 41e6fdca, local lint/check/test green.
- Branch moved while I worked: 145fb9b57 "Rename the user-visible product to Gose Bot" (fgbhhnnn, 20:55). Rebased my fix on top (ed2c12a4c, fast-forward push, CI green). Built iOS from 41e6fdca = 8579ea5e1 + 1.0.8 bump + image fix, WITHOUT the rename (not part of the 20:07 approval).
- iOS build #2 c43a6686-fec8-4212-8fd9-c9e145cea79a FINISHED 21:29: 1.0.8 (7), commit 41e6fdca. Not submitted to TestFlight (the ios-testflight build profile has no autoSubmit; submit needs a separate eas submit).
- cmvjbejsp 21:29: running, healthy (recovered 20:38).
- cmvjbejsp 21:21–21:41: sleep job 2919 (new worker) hung in checkpoint again → the 20-min bound fired (1,202,938 ms), computer.sleep_deferred + computer.health_unresponsive (unresponsiveCount=1). The computer was not left stuck; runs requesting it at 21:37–21:46 were provisioned within ~1–14 s. State 'running' at 21:47, next sleep job 2928 at 21:56. FINDING: this computer's checkpoint/snapshot hangs repeatedly (root cause provider-side / large state, not yet known). After 3 consecutive failures the restart card will be offered to the owner automatically. Not touched by me.

## 2026-10-25 23:10 (UTC+8) Think/computer lanes (cdc2c2bdd + cbe6f3b2c, pushed on top of dba00087)
- Lanes: computer 4/bot (RAKAZO_BACKGROUND_TASKS_PER_BOT, max 10), think 20/bot (RAKAZO_BACKGROUND_THINK_TASKS_PER_BOT, max 20, 0=off). Think slots 101..120, no computerId, no lease, computer tools withheld + refused at call time; think workers keep write_page/edit_page/read_page.
- Local: lint 0 errors, check 22/22, mobile check ok, build ok, vitest 1004 files / 15140 passed (93 DB-gated skipped). Local Postgres 60/72 incl. both new lanes suites; the other 12 (pi-offline, eval-*, history-*, usage-accounting, computer-approval) fail with "models/connect: 400" identically on baseline dba00087 → box env, not code.
- Local env gotcha: /home/box/.local/bin/pnpm is a DeepSeek-Harness corepack shim that resolves nested pnpm to v11; use PATH=/workspace/pnpm9/bin:/workspace/node24/bin:... (standalone pnpm 9.15.0).

## Deploy sha-dba00087 (Page cards + Gose Bot rename) — 2026-10-25 22:38–23:10 UTC+8
- Images: workflow_dispatch run 40202225850 (app/computer/updater, amd64+arm64); manifests checked on server.
- Backup: /data/backups/pg-20261025-143836/rakazo.dump (40,091,101 B, 885 TOC), /opt/rakazo/.env.bak-20261025-143836, /opt/rakazo/docker-compose.images.yml.bak-20261025-143836.
- Started 22:38:36, containers up 22:48 UTC+8; migration 20261025200000_artifact_pages finished 22:47:43 UTC+8; api/worker/supervisor healthy, 0 restarts, 0 error-level log lines; / and /healthz 200; title "Gose Bot".
- OTA (message "Page cards + Gose Bot rename (dba00087)"): 1.0.8 production da3e056f-be68-4918-9acc-e806e1dbcd66, 1.0.8 preview 0fbce041-c791-4c2d-9396-e8b6c5a76fa7, 1.0.7 production 1d57f7f4-f227-4627-8763-9caaec0091df, 1.0.7 preview 5be42efa-a424-45a0-b9de-b6dd3c306b26 (1.0.7 ones were already out before user said 23:05 only 1.0.8 is needed; left as is).
- Test account (调度测试): report request → bot dispatched a worker → page card relayed in the main chat (file block with page meta on the relay message); reader opens with TOC; API edit v1→v2, stale baseVersion rejected 409; UI edit+Save → v3; Artifacts "Pages" row shows it; /app/pages/:id route works; no page errors.
- Observations (minor):
  1. The page card sits under "Message from 调度测试 · 后台1" (worker relay), not as the main bot's own message — expected by design, but the main bot's completion text says "页面卡片已在上面".
  2. Artifacts shows the page twice: in the Pages row and also as an "MD v3" file card in the grid.
  3. Pages-row card snippet is long (~160 chars) making the card tall; could clamp lines.
  4. Logged-in shell has no visible "Gose Bot" text in the body (only the tab title) — fine.
- CI for cbe6f3b2c all green: ci https://github.com/fgbhhnnn/rakazo/actions/runs/40204764021, image https://github.com/fgbhhnnn/rakazo/actions/runs/40204763989, Computer runtime https://github.com/fgbhhnnn/rakazo/actions/runs/40204763950, desktop-macos-screenshot https://github.com/fgbhhnnn/rakazo/actions/runs/40204763990. NOT deployed.
- Bot edit: asked the bot to add "一句话结论" to the same page → worker edited it in place, v3→v4, still 1 page (no new page created); updated card relayed.
- Normal chat OK; tool check: main bot delegates web_fetch to a worker (main bot has no web_fetch, same as before), worker returned "Example Domain".
- Test harness noise (not an app bug): two of my test scripts reported "interrupted/aborted" but kept running, so chat/tool prompts were sent 2–3× (seq 1875–1877, 1880–1882); the bot answered sensibly, no runaway.

## 2026-10-25 23:52 (UTC+8) Background-task progress card (a74084b9f, pushed on top of cbe6f3b2c) — NOT deployed
- New message block kind task_progress: one card per batch in the main chat, rewritten in place (thread.message.updated). Server-side refresh: job reconciler every 30 s + right after background_task/_message/_cancel + after a worker result is delivered. Client counts run time up; server only writes on state/step change.
- Milestones posted by server once each: stuck (running, no worker event for 10 min — constant TASK_STUCK_MS; an env knob was dropped because compose-env.test requires every read env var in the compose allowlists) and a failure whose result never reached the main bot. background_task_status adds stuck/quiet_for_min.
- Local: lint 0 errors, check 22/22, mobile check ok, build 7/7, vitest 1007 files / 15155 passed (DB-gated skipped). Postgres: full run 80/81 + push-token-store PASS under the UTC script; re-run of background-task*/worker-* suites after the final fix all PASS. (The models/connect 400 suites passed this time too.)
- First full test run caught: bot-messages.test mocks lack backgroundTaskQueue → refreshTaskProgressForWorkerRun now fully best-effort (try/catch), and the env knob above. No tests loosened.
- Old 1.0.7 mobile clients don't render the new block (unknown kind → nothing); 1.0.8 OTA needed to see it on phones.
- Screenshots (mock data): /workspace/shots/rakazo-progress/web-card.png, mobile-card.png (react-native-web render of the RN component, light theme).

## Deploy sha-cbe6f3b2c (background think/computer lanes) — 2026-10-25 23:32–00:02 UTC+8
- Images were missing → workflow_dispatch https://github.com/fgbhhnnn/rakazo/actions/runs/40207390052 (success 23:38:38); app/computer/updater manifests OK on server.
- Backup: /data/backups/pg-20261025-153947/rakazo.dump (40,170,886 B, 886 TOC), /opt/rakazo/.env.bak-20261025-153947, /opt/rakazo/docker-compose.images.yml.bak-20261025-153947. Only RAKAZO_IMAGE_TAG changed (same key set). No migration in this commit.
- Started 23:39:47, containers on new image 23:40:22–23:41:04 UTC+8; api/worker/supervisor healthy, 0 restarts, 0 error lines in 30 min; / and /healthz 200, title Gose Bot. RAKAZO_BACKGROUND_THINK_TASKS_PER_BOT not set → defaults (status tool reports computer 4 / think 20).
- OTA 1.0.8 only: production 36636dd8-d63c-4385-be55-c7a7595418cb (23:42:07), preview 393b8e30-7de2-412f-8cb6-170c03d491b8 (23:43:44). No 1.0.7.
- Tests (test account, 调度测试; each prompt sent exactly once via a marker-guarded script, user msgs 1888,1914,1916,1926,1936,1938,1944):
  - A 6 think tasks in one ask: slots 后台101–106, lane think, worker computerId NULL, all started 23:45:55–57, done 23:46:09–19 (parallel); test computer stayed `suspended` throughout. PASS
  - B background_task_status: bot reported lane per task + limits computer 4 / think 20. PASS
  - C computer + think together: computer task on 后台1 (shared computer, woke suspended→running 23:49:31, uname/date/python outputs returned); think task on 后台101 finished at 23:49:31 without waiting for the computer. PASS
  - D think task that needs the computer (user forced lane think): think worker could not read the file → dispatcher automatically re-sent as computer task #TB1JRHDF → returned PRETTY_NAME="Ubuntu 22.04.5 LTS". PASS
  - E normal chat PASS; Page card from computer-lane report PASS; Page card from an explicit think-lane task (#THVTQ4QZ, slot 101, no computer) PASS, reader opens.
- Issues / observations:
  1. Dispatcher put a plain "write a report page" request in the computer lane (#TF4KMEYF) although pages need no computer; lane guidance says "anything that must save a file → computer" and doesn't mention pages are fine in think. Wastes a computer wake for page-only reports. Suggest adding "pages (write_page) are fine in think" to BACKGROUND_LANE_GUIDANCE.
  2. Worker logs: 3× "in-run compaction failed; continuing without it" (warn) in 30 min; 6× csp.violation warns on api (likely from my headless browser). Not investigated.
  3. Test computer cmvk9w1km is now running (woken by test C/D); left to idle-sleep normally.
  4. Single-section page shows no "On this page" list (by design, presumably) — fine.
- CI for a74084b9f all green (00:02 UTC+8): ci https://github.com/fgbhhnnn/rakazo/actions/runs/40208908637, publish-server-image https://github.com/fgbhhnnn/rakazo/actions/runs/40208908633, Computer runtime https://github.com/fgbhhnnn/rakazo/actions/runs/40208908614, desktop-macos-screenshot https://github.com/fgbhhnnn/rakazo/actions/runs/40208908667. NOT deployed (prod = sha-cbe6f3b2c).

### Progress card: UI polish + lane fix (2026-10-26)
- Lane bug: a page-only report request with no lane went to "computer" and woke the computer. Fixed in BACKGROUND_LANE_GUIDANCE, background_task lane description and the heavy-task skill: pages (write_page/edit_page/read_page) live on the server, so they go to lane "think". Tests: background-task-lanes.test.ts, builtin-skills.test.ts. Commit 5d41ed09e.
- Card UI moved onto the existing system (PageCard frame, theme tokens, typeScale). Mobile: NativeSymbol per state (SF Symbols on iOS, Ionicons fallback on Android), ActivityIndicator while running. Web: lucide icons in the same frame. No new native deps; ships by 1.0.8 OTA. Commit 3883a7186.
- Screenshots are react-native-web renders on Linux (no simulator). Android uses the real Ionicons font. On iOS the SF Symbols are drawn with similar SVGs. Still needs a check on real devices.
- Local CI 3883a7186: lint/check/test/build 0 (1007 files passed, 94 DB-gated files skipped). pg 80 suites passed; push-token-store fails only under the box TZ and passes in the UTC run (known env issue above).

## Deploy sha-3883a7186 (background-task progress card + page→think lane fix) — 2026-10-26 00:29–00:57 UTC+8
- Full sha 3883a7186e863f79c7b14b29cca72864d6b0e5a7. Images were missing → workflow_dispatch https://github.com/fgbhhnnn/rakazo/actions/runs/40211911761 (success 00:36:10); app/computer/updater manifests OK.
- Backup: /data/backups/pg-20261025-163741/rakazo.dump (40,928,445 B, 886 TOC), /opt/rakazo/.env.bak-20261025-163741, /opt/rakazo/docker-compose.images.yml.bak-20261025-163741. Only RAKAZO_IMAGE_TAG changed.
- Started 00:37:41, containers on new image 00:38:18–00:39:00 UTC+8. No new migration (latest still 20261025200000_artifact_pages, 0 unfinished). Healthy, 0 restarts, / and /healthz 200, title Gose Bot.
- OTA 1.0.8 only: production 20d12421-d86b-446d-b4ec-2a075698babb (00:39:41), preview 1084bf33-c182-4a0f-9fe5-528b6e2e69b1 (00:41:23). This commit has mobile changes (progress card); no 1.0.7.
- Tests (test account 调度测试, each prompt sent once; user msgs 1950, 1957, 1974, 1981):
  - Page-only report (no lane named) → think lane #T237688O (slot 101, no computer), computer stayed suspended, page card shown. PASS (lane fix works)
  - Batch of 4 (2 think + 2 computer) → ONE task_progress card (msg seq 1960, same message id throughout), rewritten in place ~every 30 s: think rows running→done, computer row step "Running: echo step1…" → step2 → step3 → step4 → done; no new chat message per refresh. Card closed ("Background tasks finished", "3 done · 1 not finished") when all ended. PASS
  - Row tap opens the worker's thread (/app/<workerBotId>, 调度测试 · 后台2). PASS
  - done / failed (red, with reason) / cancelled states render on web light + dark. PASS
  - background_task_status: lanes and states correct; stuck field correctly absent (task was quiet < 10 min). PASS
  - A later task opened a new card (seq 1979) after the first closed — as designed.
- Stuck notice: NOT observed. The 11-min silent `sleep 660` shell call returned after ~5 min (16:44:21→16:49:22 UTC: the shell tool caps a call at about 5 min), then the worker's next model call failed "Upstream request failed", so the task failed at 5m42s instead of going quiet for 10 min. No practical way to keep a worker silent for 10 min on a test task; covered by unit/postgres tests only.
- Issues / observations:
  1. Two "Upstream request failed" model errors within ~5 min (main-bot reply msg 1970 at 00:45:28, and worker #T57HFX4D at 00:49:55) plus one "reply took longer than 90 s and was stopped" (worker). Provider-side, not this change; the main bot recovered and re-posted the missed results in its next reply.
  2. After #T57HFX4D failed, the main bot re-dispatched the same command on its own (#TDGO3Q19) without asking; I had it cancelled (cancel worked, card shows cancelled). Auto-retry of a failed long task may surprise users.
  3. Failed task's result did reach the main bot, so (correctly) no "failed without report" notice; that notice path was not exercised live.
  4. Test computer is running (woken by the computer tasks); left to idle-sleep normally. 0 non-terminal runs/tasks at the end.

## 2026-10-26 08:14–08:26 UTC+8 — deploy sha-074f8b9f0 (duplicate media + view-only cards)
- Backup: /data/backups/pg-20261025-235502 (rakazo.dump 41 MB + .env.bak + compose .bak). No migrations (146, up to date).
- Live: sha-074f8b9f0d897d51144a90bcc16fc45d3f3fa9e3 since ~08:14; rollback sha-3883a7186. Images pruned to 074f + 3883.
- OTA 1.0.8 (per-platform, Node 24): production android 79f2b7f2-8575-412d-af7e-db79d08aaa32, ios 592c59ec-c770-4f84-803c-c061b41c1a6c; preview android e3d9bde3-ebe0-42d7-b7fd-6cb23a045073, ios fd5afc0b-ca93-4a02-9660-f0acb1954487.
- Web/API verify PASS: one image (kind=image) for worker PNG relay #TEZW7I1A, no「预览还在补」; batch of 3 → one progress card; child titles「进度见后台任务卡片」; web rows not navigable; page-only task lane=think.
- ISSUE (user report): iOS progress card collapsed to narrow column, text wraps vertically ('50s', '运' stacked). Likely 59af451ca: row changed from Pressable style-fn to plain style object / removed width-giving chevron; also thread.tsx card wrapper change. Not reproduced here (no iOS device run). 089 deploy on HOLD.
- OTA tooling: `eas update --platform all` fails on Node 20 (web export, app.config.ts "Unexpected token '{'"); use /home/box/node24 + --platform ios / android separately.

## 2026-10-26 09:22–10:02 UTC+8 — deploy sha-cbfb40b97 (merge/upstream-cbf759c HEAD = 089c74788 + 5 fixes) + OTA 1.0.8
- Image: PR publish run only validates, so dispatched publish-server-image https://github.com/fgbhhnnn/rakazo/actions/runs/40253861171 (success) → ghcr.io/fgbhhnnn/rakazo/app:sha-cbfb40b9727cee7b432a01d195800764395425fe (created 09:28:58 UTC+8). CI 40251669530 success.
- Backup: /data/backups/pg-20261026-012207/ (rakazo.dump 42,983,742 B, .env.bak, docker-compose.images.yml.bak); also /opt/rakazo/.env.bak-20261026-012207 and docker-compose.images.yml.bak-<TS>. pg_restore -l = 886 TOC lines; full restore into a scratch DB: 0 errors, 82 tables / 146 migrations = live; scratch DB dropped.
- Deploy: tag switched 09:30:15, pull ~6 min; api listening 09:37:28; web/worker up ~09:38. Migrations via api start (pnpm db:deploy): 6 applied (agent_imports, messaging_installations, drop_space_backup_models [0 rows], drop_model_preference_default, account_settings [backfill: user_model_role_choices 1, user_model_preferences 1, overrides 0], boat_computer_kind [0 box rows]). migrate status: 152, up to date; 0 unfinished. GIT_SHA=cbfb40b9…; RAKAZO_AGENT_IMPORT_ENABLED unset (not passed by server compose either). /healthz 200, / 200 "Gose Bot"; 0 error log lines.
- Rollback: .env RAKAZO_IMAGE_TAG=sha-074f8b9f0d897d51144a90bcc16fc45d3f3fa9e3 + pg_restore of the dump above (migrations are destructive) — only with user approval.
- OTA 1.0.8 (checkout cbfb40b97, Node 24, per platform, rt 1.0.8): production ios 01a175dc-dfcb-7b96-b111-e06498e98905, android 01a175df-81dd-7350-b2a6-9ccaa81d43a3; preview ios 01a175e0-801f-7177-9675-07c8e379ecf0, android 01a175e1-6dfd-7a88-bfed-6ed48d00df10. Needed `pnpm install --frozen-lockfile` first (lockfile changed after the upstream merge).
- Verification (test account only): member lock (models.rename/disconnect with nonexistent ids → 403 "Your administrator manages this setting."), models.list/credentials readable, deployment.get + security.events 403 PASS; model config hashes (space_model_preferences excl. isDefault, role choices, credentials, provider configs) identical before/after PASS; agent import bots.import* → 404 "Agent import is not available." PASS; dup media with double attach → 1 image, 1 ack + 1 result PASS; batch of 3 → 1 progress card PASS; web card static 280px, no chevron, click doesn't navigate PASS; no worker names / "来自…后台" lines in web body PASS (raw bot_message_* blocks still stored, filtered client-side); page card 1, think lane #TNUBOXLT PASS; roster recent-first + pinned on top (pinned New Bot temporarily, unpinned after) PASS; computer suspended→running on demand, explicit stop running→stopped (checkpoint), stopped→running PASS; CodeChat containers/images unchanged, 0 restarts PASS. Mobile iOS card width: unit tests pass (4 files, 39 tests); not checked on a real device.
- Not exercised: computer restart card (needs repeated health-check failures; no fault injection done). 0 restart cards in thread.
- Observation: page card relayed from the worker shows a reply-quote line "↩ 调度测试: 【后台任务】验证页 …" above it on web. Not a 来自…后台 receipt, but it does show the 【后台任务】 label.
- Script bug (mine): verify-cbfb.py page step crashed on a kwarg clash; recounted from messages.
- Images pruned: kept sha-cbfb40b97 (current) + sha-074f8b9f0 (rollback); removed sha-3883a7186. /data 37G before pull → 44G after pull → 40G after prune (Images 39.8GB → 35.47GB).

## 2026-10-26 11:29–12:20 UTC+8 — deploy sha-b96e8e2f3 (merge/upstream-f91653215, PR #4)
- Image: publish-server-image run 40264383055 (manual dispatch; PR run 40263193295 didn't push). Tag created 11:40:13 UTC+8.
- Backup: /data/backups/pg-20261026-033042/ (rakazo.dump 46,235,018 B + .env.bak + docker-compose.images.yml.bak); also /opt/rakazo/.env.bak-20261026-033042 and docker-compose.images.yml.bak-20261026-033042. Full restore into a scratch DB: rc 0, 0 errors, 90 tables / 152 migrations / 3938 messages / 42 bots matched live. Scratch DB dropped.
- Deploy: tag switched 11:41:02 UTC+8. Waited for a real bot run (UniApp → Expo 迁移 · 后台1) to finish first. api listening 11:46:41 UTC+8; web/worker up 11:46:45 UTC+8. All 4 app containers run b96 and are healthy; GIT_SHA=b96e8e2f395b6eadbdf4ea80d072efcc6ab81efd; /healthz 200; 0 error/fatal log lines since the switch.
- Migrations (7, 159 total, schema up to date): computer_runs; messages_runId_seq_idx, runs_taskId_idx, runs_botId_idx, computer_execution_leases_botId_expiresAt_idx (all CONCURRENTLY, all valid/ready); model_oauth_sessions; computer_runs_provider_ref. 0 invalid indexes. RAKAZO_AGENT_IMPORT_ENABLED and MCP_STDIO_ENABLED unset.
- OTA (from the b96 checkout, app.json 1.0.8, runtime 1.0.8, --environment preview, EXPO_PUBLIC_API_URL=https://rakazo.lllltt.com):
  production ios 01a17653-b860-7556-99b9-aecb74182eee; production android 01a17654-894c-7e54-b424-a704e9c34525;
  preview ios 01a17655-43cd-7802-bff0-a1032abdc4d3; preview android 01a17655-f437-76c4-9f7b-79651fe5034e.
- Test account checks (screenshots and JSON in /workspace/screenshots/deploy-b96/):
  PASS member/admin locks (models rename/disconnect 403; deployment.get and security.events 403); approvalRules.set/remove, autoReview.set and spaceSettings.setOverride(confirmations) all 403 "Your administrator manages this setting.", with no state change (rules [], overrides []).
  NOT LIVE-TESTED: refusing the "always" answer. No approval card could be raised on the test account: the main bot has no forget_memory/generate_image tool, and generate_image is unavailable to workers too. Covered by unit tests and the guard code path only.
  PASS model config hashes identical before/after (smp, smrc, umc, ipc, umrc, ump).
  PASS a worker-published Page gives exactly one card, with no .md/.html next to it and no "↩ …【后台任务】" quote in the UI. The raw replyPreview is still stored; the client drops it.
  PASS progress cards: border 0px, radius 20px, filled, no chevron, clicking leaves the URL unchanged. Card width 280px = its container width.
  PASS no "来自…后台" receipts or worker names in the UI (raw receipt blocks are still stored).
  PASS media dedup on the rerun: unique-bytes PNG attached twice gives 1 image. The first try (8x8 solid PNG) gave 0 images because the bytes matched img_TK0358D1.png posted at 09:48 UTC+8, inside the new 6h thread-wide dedup window. That's intended, not a regression.
  PASS a batch of 3 tasks gives 1 progress card with 3 tasks done.
  PASS chat list: pinned New Bot shows under 置顶 on top, the rest under 未分配; unpinned again afterwards.
  PASS agent import: importInfo/importPreview/importSetupState give 404 "Agent import is not available."; onboarding shows no import entry (AGENT_IMPORT_ENABLED=false).
  PASS approvals settings page loads: Mode toggle (从不询问/自动/询问, 自动 selected), disabled, with the "此设置由管理员统一管理" note.
  PASS computer suspend and wake: suspended→running; computer/stop running→stopped, which took about 4–5 min; computer_runs has rows (3, including ended row 11:51:45–12:03:48 UTC+8 endReason=stopped).
  PASS zh-TW: html lang=zh-TW, Traditional UI strings (處理中…, 連接應用程式, 背景任務已結束). Simplified text is only in chat content.
  PASS CodeChat images and all other CodeChat containers unchanged; codechat rows 0/0 in the rakazo DB.
- Issues:
  1. Opening /onboarding on the test account created a first-run bot "Chief" (spawnKey onboarding:first, waiting_input with a focus question). This is by design and happened in the test space only. Left as is.
  2. codechat-main-api-1 was recreated at 11:46:22 UTC+8, same image. /etc/codechat/main.env changed at 11:46:21 UTC+8 by something outside this deploy; the rakazo compose and logs never touched codechat. Not investigated (that file holds secrets).
  3. rakazo-postgres-1 runs postgres:16, but that tag now shows as postgres:<none> e17e86066e5e. Not touched by this deploy (I only ran rmi on the app tag).
- Prune: removed app sha-074f8b9f0 (0 containers). Kept sha-b96e8e2f3 and sha-cbfb40b97. /data 44G→40G used (46%→42%); docker images 39.79GB→35.47GB.
- Rollback: sha-cbfb40b97 + /data/backups/pg-20261026-033042.

## 2026-10-26 Dispatcher image turns hit the 90 s reply limit — fix PR #5 (NOT deployed)
- Cause: dispatcher main turn got this turn's images + up to 3 history image turns; grok took >90 s to first token; 90 s wall-clock watchdog; restarts reran identically.
- Fix branch fix/dispatcher-image-timeout, commit 7a1d065c92a8737ac3ebe50b909b2352a879e81e, PR https://github.com/fgbhhnnn/rakazo/pull/5 (base merge/upstream-f91653215).
  1) dispatcher main turn gets an image note instead of bytes (dispatcher-image-context.ts); workers still get/see images.
  2) idle watchdog (RAKAZO_DISPATCHER_TURN_MAX_MS = no-progress limit, new RAKAZO_DISPATCHER_TURN_HARD_CAP_MS default 300000) (dispatcher-idle-watchdog.ts).
  3) timeout retry uses lighter history (dispatcher-retry-context.ts).
- CI https://github.com/fgbhhnnn/rakazo/actions/runs/40284548623 success; PR image check 40284548579 success; image via workflow_dispatch https://github.com/fgbhhnnn/rakazo/actions/runs/40284557074 success (15:23 UTC+8) → ghcr.io/fgbhhnnn/rakazo/app:sha-7a1d065c92a8737ac3ebe50b909b2352a879e81e (digest sha256:81b247eb…). NOT deployed; no OTA needed (server-only).
- Note: compose files gained RAKAZO_DISPATCHER_TURN_HARD_CAP_MS passthrough; server's /opt/rakazo compose doesn't need it (default applies).

## 2026-10-26 15:28–16:02 UTC+8 — deploy sha-7a1d065c9 (PR #5, dispatcher image-turn timeout fix)
- CI re-confirmed: ci 40284548623, publish-server-image 40284548579 (PR), 40284557074 (dispatch) all success on 7a1d065c9.
- Backup (server UTC TS 20261026-073014): /data/backups/pg-20261026-073014/ (rakazo.dump 49,497,233 B + .env.bak + docker-compose.images.yml.bak); also /opt/rakazo/.env.bak-20261026-073014 and docker-compose.images.yml.bak-20261026-073014. TOC 996 lines; full restore into scratch DB rc 0, 0 errors, 92 tables / 159 migrations / 4107 messages / 44 bots = live; scratch dropped. Extra copy /opt/rakazo/.env.bak-predeploy-7a1d (same perms, made by the deploy script).
- Waited ~25 min for a real worker run (UniApp → Expo 迁移 · 后台1, running since 14:54) to finish before switching. Image pre-pulled meanwhile.
- Tag switched 15:54:56 UTC+8 (only RAKAZO_IMAGE_TAG changed, same key set, 2 diff lines; compose untouched). api healthy ~15:55:10, web/worker up 15:55:49. Revision label 7a1d065c9 on all app containers; /healthz 200, / 200. "159 migrations found… No pending migrations to apply." 0 error/fatal log lines (6 warn: csp.violation/security.event).
- Test account (bot 调度测试) — /workspace/screenshots/deploy-7a1d/verify-7a1d.json:
  PASS 4 PNGs (red circle, blue square, green triangle, text "KIWI 7351") → main run 24 s, completed, no error, first reply "已派出「看四张图」#TS1WXIM0"; worker run 57 s, completed; worker task message seq 541 carries 4 image blocks; final reply described all 4 correctly incl. "KIWI 7351" (only in pixels). No 回复超时, no retry runs.
  PASS plain text PONG reply in ~16 s (run 13 s).
  Idle watchdog: no logging exists for it; evidence is indirect (0 timeout errors, new code present in api/worker dist).
- Prune: removed app sha-cbfb40b97 (0 containers). Kept app sha-7a1d065c9 + sha-b96e8e2f3; computer is elie222 :edge (in use, kept); no fgbhhnnn computer/updater images present locally. /data 43G→39G.
- Rollback: RAKAZO_IMAGE_TAG=sha-b96e8e2f395b6eadbdf4ea80d072efcc6ab81efd (no DB restore needed; no migrations).
- Observation: CodeChat containers were recreated 15:09–15:10 UTC+8 (/etc/codechat/main.env changed 15:08), before this deploy touched the server; not caused by it, not investigated.

## 2026-10-26 16:01–16:09 UTC+8 — deploy sha-97e2f565c (PR #6) PREPARED, NOT SWITCHED
- CI green: ci 40286854676, PR image 40286854733, dispatch publish 40286912114 (all success on 97e2f565c). No packages/db diff vs 7a1d.
- Backup /data/backups/pg-20261026-080215/ (rakazo.dump 49,658,291 B + .env.bak + compose .bak; also /opt/rakazo/.env.bak-20261026-080215 + compose .bak). TOC 996; full restore rc 0, 0 errors, 92 tables/159 migrations/4126 messages/44 bots = live; scratch dropped.
- Image app:sha-97e2f565c… pulled on server. Deploy script aborted on its active-run guard (no change made). Live still sha-7a1d065c9.
- Blocked by real run cmvoz4zga000w07q9qir6nlna (UniApp → Expo 迁移 · 后台1, started 16:07:49 UTC+8). Per parent: stop and ask user when to switch.
- For the 15:54 investigation: previous run cmvowizwh00iz06mzj1vfqfxo is status=completed, error none, updatedAt 15:53:56 UTC+8 — it ended before the 7a1d switch (15:54:56); active-run check at 15:54:45 was 0.

## 2026-10-26 16:43 (UTC+8) — 已切换到 sha-97e2f565c (PR #6 头像菜单精简)
- 切换前检查：cmvoz4zga 已于 16:17:14 完成；background_task_queue 0 个进行中；activeRuns 0
- 新备份：/data/backups/pg-20261026-084256（完整恢复演练通过：rc 0，0 错误，92 张表 / 159 条迁移 / 4153 条消息 / 44 个 bot，均与线上一致）
- 16:43:38 切换，只改了 RAKAZO_IMAGE_TAG（.env.bak-predeploy-97e2）；159 migrations found，No pending migrations to apply
- api/web/worker/supervisor 的 revision 都是 97e2f565c，restarts=0，/healthz 200，/ 200；error/fatal 日志 0 条（api 有 5 条 csp.violation 警告，无影响）
- 头像菜单（测试账号）：用量 / Artifacts / 设置 / 退出登录 都在；获取移动应用、文档 已消失；页面 JS 报错 0 → /workspace/screenshots/deploy-97e2/avatar-menu.png (+ .json)
- 纯文字测试（调度测试）：PONG_TK1DE394，7.8 秒回复，没开后台任务
- 已删除 b96 镜像；保留 97e2 + 7a1d + computer:edge。回滚目标：sha-7a1d065c9。CodeChat 没动（已运行 2 小时）

## 2026-10-26 17:24–17:42 (UTC+8) — 部署 sha-c5c62901b (PR #7：worker 未完成自动继续 / 继续中 卡片 / 进度提醒) + 1.0.8 OTA
- CI 全绿：ci https://github.com/fgbhhnnn/rakazo/actions/runs/40294655228 ；PR 镜像检查 https://github.com/fgbhhnnn/rakazo/actions/runs/40294655231 ；手动发布 https://github.com/fgbhhnnn/rakazo/actions/runs/40297607142（app/computer/updater 都 success，skipped 都是条件跳过）
- 迁移：和 97e2 比 packages/db 没有变化；启动日志 "159 migrations found / No pending migrations to apply"
- 备份：/data/backups/pg-20261026-092556（50.7MB，TOC 996，完整恢复 rc 0、0 错误，92 张表 / 159 条迁移 / 4174 条消息 / 44 个 bot 与线上一致，临时库已删）；另存了 /opt/rakazo/.env.bak-20261026-092556 和 .env.bak-predeploy-c5c6
- 切换前：队列（queued/claiming/started）0 个，running/queued/leased 的 run 0 个。只有 1 个 waiting_input 的 run（cmvoqb50c，测试账号的 Chief，12:00 的引导选择题），没在执行，不阻塞
- 17:31:04 切换，只改了 RAKAZO_IMAGE_TAG（diff 2 行，key 集合不变）；4 个应用容器 revision 都是 c5c62901b，restarts=0，/healthz 200，/ 200，error/fatal 0 条
- api 有 warn：csp.violation 7 条、security.event 2 条，另有 db.pool.saturated 1 条（17:32:24，刚启动时并发大，只出现一次）
- 服务器上没有 deploy-main.sh（/opt/rakazo 用的是 install-images.sh + 手动 compose），按要求不动，仓库里的新等待逻辑没有同步到服务器
- OTA（仅 1.0.8，c5c62901b，node24，--environment preview）：production ios 01a1778e-eb2a-78c8-8665-9a3326313cc8；production android 01a1778f-e1ed-73b1-9d6a-8c13a7d8eaad；preview ios 01a17790-9818-7d34-9bf9-28ba0d7f557d；preview android 01a17791-454d-7876-bcdf-59d64a32b53e
- 测试账号验证（/workspace/screenshots/deploy-c5c6/）：
  PASS 纯文字：PONG_TK126446，7.6 秒
  PASS 小后台任务 #T80PXHCZ：运行中 → 完成，结果 DONE_TKBB6AAE（B-01-running.png、B-final-done-card.png）
  PASS 未完成自动继续 #TA7XRM3G：运行中（17:35:54）→ 继续中（17:36:00）→ 完成（17:36:05）。DB 里 incompleteContinues=1，最终结果是"两步都完成：STEP1_TKBC2578 STEP2_TKBC2578"（C-01-running.png、C-02-continuing.png、C-03-done.png、C-timeline.json）
  小问题（纯显示）：继续中状态的卡片显示"继续中 · 继续中"（state 标签 + step 兜底文字重复了），没有修
- 镜像：删除 7a1d，保留 c5c6 + 97e2 + computer:edge。回滚目标 sha-97e2f565c（不需要恢复 DB）
- 旁注：CodeChat 容器在 17:33–17:35 被别的操作重建（/etc/codechat/main.env 17:32:03 修改，codechat-api 换成 test-15c60918… 镜像），跟本次部署无关，我没碰

## 2026-10-26 19:13–19:25 (UTC+8) — 部署 sha-0c31ff671（PR #8：进度卡片的 继续中 只显示一次）+ 1.0.8 OTA
- CI 全绿：ci https://github.com/fgbhhnnn/rakazo/actions/runs/40307052926 ；PR 镜像检查 https://github.com/fgbhhnnn/rakazo/actions/runs/40307052660 ；手动发布 https://github.com/fgbhhnnn/rakazo/actions/runs/40308921375
- 迁移：和 c5c6 比没有 db 改动；启动日志 "No pending migrations to apply"（共 159 条）
- 备份：/data/backups/pg-20261026-111422（完整恢复 rc 0、0 错误，92 张表 / 159 条迁移 / 4250 条消息 / 45 个 bot 与线上一致，临时库已删）；.env.bak-predeploy-0c31
- 切换前：队列 0 个，进行中的 run 0 个（只有那个 waiting_input 的 Chief 引导题 cmvoqb50c）
- 19:19:38 切换，只改了 RAKAZO_IMAGE_TAG；4 个应用容器都是 0c31ff671，restarts=0，/healthz 200，/ 200，error/fatal 0 条（warn：csp.violation 5 条、security.event 2 条）
- OTA（仅 1.0.8，0c31ff671）：production ios 01a177f1-1c21-7f00-bcca-f337b9172a3f；production android 01a177f2-142c-7711-9d32-cfd62a4f70f8；preview ios 01a177f2-f186-74a1-8cd7-f02effeed64f；preview android 01a177f3-c63a-7946-ae18-31e2738c6dea
- 测试账号验证（/workspace/screenshots/deploy-0c31/）：
  PASS 纯文字 PONG_TKF5FDA9，9.5 秒
  PASS 两步任务 #T2TVGWPP：运行中（19:22:07）→ 继续中（19:22:15，只显示一次，C-02-continuing.png）→ 完成（19:22:19，C-03-done.png）。DB 里 incompleteContinues=1，最终结果"两步都完成：STEP1_TKE02136 STEP2_TKE02136"
- 镜像：删除 97e2，保留 0c31 + c5c6 + computer:edge。回滚目标 sha-c5c62901b

## merge/upstream-497e1ea6f (2026-10-26)

- Local lint, typecheck (`pnpm check`), and full unit (`pnpm test`: 16648 passed) green after porting fork features into the executor/mobile/pi-runtime split.
- Speech: kept CJK weight + CJK sentence splits on top of upstream Unicode `maxChars`/`Intl.Segmenter`; tight glue for CJK/fullwidth punctuation so property tests keep `join("")` stable.
- askAnswerRunId: blocks optional (ask-card refresh-fail path passes message without blocks).
- Boat commits kept (unused provider for us; computer-idle shared path still uses ComputerHealth + SUSPEND_CLAIM_STALE_MS).
- Exclusions: Slack default-bot one-click (runtime refuse empty botId + UI restore), Kubernetes, Depot fallback, simulated-person evals (from prior exclusion commits on this branch).
- New migrations on tip: `20261026130000_routine_account_failures`, `20261026140000_computer_auto_recovered_at` (plus others already between f916 and tip).
- 12ed7a457: hides unrunnable catalog models at connect; keeps saved `provider:id` preferences — does not alter existing model configs.
- OTA: not published this turn (no deploy). UI continuing-card / mobile changes would need OTA if/when deployed.

- CI Postgres journeys: think-lane shell refused with generic "disabled" because run-tools only surfaced workerNestingRefusal. Restored pre-merge order: nesting → user-facing → thinkWorkerToolRefusal → generic disabled.
