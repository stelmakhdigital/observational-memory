# Рефакторинг-анализ observational-memory (v0.5.4, HEAD 43deb9a)

Дата: 2026-09-28. Метод: 4 параллельных deep-ревью (core / adapters / кросс-срез / eval+промпты)
+ сверка ключевых выводов с кодом + живой прогон `npm run eval` (qwen3.8-27b-fp8, 5 кейсов, $0).
Только диагностика — код не изменялся. Баги из audit.md §4 (P0/P1/P2, починены) не дублируются.

Идентификация: R* = core, A* = adapters, E* = eval/промпты, D* = dead code, S* = структура, F* = docs.

## 1. Итог

- Новых багов: **28** (2 major-класса подтверждены по коду, 4 HIGH по адаптерам, 1 воспроизведённый
  live в eval). Критичных для прода-сценариев: **R1 (chunker overlap)**, **R2 (gap-markers мёртвая
  фича)**, **A1 (Runtime не сбрасывается при /new//resume)**, **A2/A3 (MCP читает чужую/обрезанную
  сессию)**, **A5 (призрачный воркер после watchdog)**, **E1 (tail-гонка shutdown — потерян хвост
  наблюдений на конец сессии, воспроизведено)**.
- Dead code: **~15 позиций / ~200 строк** (включая `core/ledger/serialize.ts` целиком — мёртвый
  «версионированный» envelope).
- Главная структурная задача: **orchestrator.ts 1012 строк** — вынос RunManager; runner.ts —
  role-таблица; index.ts (адаптер) 511 строк — разбивка на 6 модулей.
- Docs: ARCHITECTURE.md отстал на всю v0.5-волну; README — 3 точечных рассинхрона; journal roadmap
  обрывается на v0.5.1.
- Eval: survival 0.95, poison 0/12, но eval не измеряет cross-lingual recall (слепое пятно) и
  зафиксирована tail-гонка.

## 2. Баги

### 2.1 Core (R)

| # | Sev | Местоположение | Сценарий | Фикс (без применения) |
|---|-----|----------------|----------|----------------------|
| R1 | MAJOR | `core/chunker.ts:94-101` (подтверждено) | `begin` инициализируется `0`, а не `startIdx`: тяжёлое сообщение сразу до среза (>overlapTokens) при `startIdx>1` → break с `begin=0` → `overlapContext` = **вся предшествующая история** | `let begin = startIdx` + тест на oversized-сообщение до среза |
| R2 | MAJOR | `core/orchestrator.ts:537-541` + `adapters/pi/history.ts:196-204` (подтверждено) | Gap-markers меряют `now − lastMessageAt()` на `onAgentEnd` — т.е. длительность только что завершившегося run'а, а НЕ пользовательскую паузу между сессиями. Пауза 2 дня → маркер не ставится; run >10 мин → ложный маркер. Тесты проходят только потому, что мутируют `DemoHistory.lastAt` вручную | Мерять паузу между предпоследним и последним сообщениями ветки (или хранить prev-lastAt и сравнивать на `turn_end`); тест на реальном тайминге |
| R3 | MED | `core/orchestrator.ts:862-884` + `adapters/pi/ledger.ts:61-69` | Commit-retry в том же run'е после **partial** коммита: уже записанные наблюдения получают новые seq, но тот же runId/fromId → same-run siblings не вытесняются n9-dedup'ом → дубли в пуле | Idempotent-коммит (пропуск существующих id) или commitSeq на (runId, attempt) в dedup-ключе |
| R4 | MED | `core/orchestrator.ts:301-316` | `observerConcurrency` номинален: watermark одинок, `nextChunk` отдаёт один срез, `pendingChunks` блокирует повтор → за pump стартует ровно 1 observer. «4 observers» = 1 | Честное имя (in-flight cap) либо k последовательных срезов за pump (dispatched-watermark, как в референсе) |
| R5 | MED (perf) | `core/orchestrator.ts:940-978, 370-382, 773-806` | Каждый committed observation → `emitStatus` → полный `status()` (scan леджера + readdir/readFileSync всех topics + journey + extracted + O(M) переобходы) + `maxSeqForSecond` O(n) на каждый append → sync-блоки event loop при 100+ наблюдений (NFR-1) | Кэш pool/watermark с инвалидацией по append; инкрементальный maxSeq; бинарный поиск по границам |
| R6 | LOW | `core/cost.ts:24-33` | Коррумпированный/неизвестный `role` в cost-записи → `TypeError` в `sumCosts` → ломает `/om:status` | Skip неизвестных role |
| R7 | LOW | `core/recall.ts:156-173` | Невалидные `since`/`until` (опечатка) → NaN-сравнения → фильтр молча отключается | OmError или явная пометка в выдаче |
| R8 | LOW | `core/orchestrator.ts:188-196` | `seeded=true` ДО вызова `seedFrom`: при сбросе fs-ошибки повторный seed никогда не будет | Флаг после успеха |
| R9 | LOW | `core/orchestrator.ts:139, 543` | `lastGapMarkedFor` в памяти → после перезапуска хоста та же пауза маркерится повторно | Последний marker-lastAt читать из ledger (`om.gap-marker` уже есть) |
| R10 | MICRO | `core/orchestrator.ts:731-745` | Двойная `orderByPriority` (в `trimToBudget` и в `compactionPlan`) | Одна сортировка |

### 2.2 Adapters (A)

| # | Sev | Местоположение | Сценарий | Фикс (без применения) |
|---|-----|----------------|----------|----------------------|
| A1 | HIGH | `adapters/pi/index.ts:234, 334` | `session_shutdown` приходит с `reason: 'new'|'resume'|'fork'` (замена сессии в том же процессе, pi 0.87.1), но `rt` никогда не сбрасывается → `/new` или `/resume` в TUI: OM работает с чужим sessionId/MemoryStore/runner | В shutdown: `rt = null` после drain; в `track()` — проверка совпадения sessionId и пересоздание |
| A2 | HIGH | `adapters/mcp/pi-ledger.ts:103-105` | `readPiLedger` читает **первые** 25 МБ, хотя свежее — в хвосте: сессия >25 МБ молча теряет новейшие наблюдения | Читать с `size − READ_BYTES` (симметрично scan) |
| A3 | HIGH | `adapters/mcp/pi-ledger.ts:161-185` + `server.ts:127` | Авто-скан берёт самую свежую сессию **по всем проектам**; два проекта → `om_status`/`om_recall` отвечают по чужой сессии, `om_topics` — по своей | Сверять session id из header-строки с ожидаемым; при mismatch — fallback + пометка в статусе |
| A4 | HIGH | `adapters/pi/runner.ts:318-327` | Drain-watchdog (≤60 c) форс-резолвит **без kill**: воркер в своём process-group (detached) выживает и дожигает LLM-вызов после выхода pi — деньги списаны, результат выброшен | `killTree(p)` перед `done()`; `watchdog.unref()` |
| A5 | MED | `adapters/pi/index.ts:317-332` | Комментарий «wait for in-flight observers (best effort)» ложен: хук `session_before_compact` синхронный, observers не ждутся; внешняя (threshold/overflow) компакция рендерит блок без свежих наблюдений | Хук → async + `await drainForCompaction(tailBoundaryId)` (логика `mustWaitFor` уже в core: orchestrator.ts:595) |
| A6 | MED | `adapters/pi/config.ts:68-76` | (а) `memoryDir` — фиксированный `.memory`, коммент обещает несуществующий override; (б) неизвестные ключи namespace молча игнорируются (против FR-9.3 fail-loudly) | Whitelist ключей namespace → problems; memoryDir — реализовать или поправить коммент |
| A7 | MED | `adapters/mcp/server.ts:259` | Каждый tool-call заново делает `initState()` (скан 50 файлов × 5 МБ + parse) — медленно; источник может поменяться между вызовами | Ленивый init + кэш |
| A8 | MIN | `adapters/pi/runner.ts:201-211` | После timeout снимаются только `data`-слушатели; `close`/`error` + накопленные stdout/stderr висят в памяти до close (может не прийти — внук держит pipe) | `removeAllListeners('close'/'error')` в timeout-ветке |
| A9 | MIN | `adapters/pi/runner.ts:216` | `stdout +=` без предела — зависший болтливый воркер стримит сотни МБ в память | Кап буфера (держать хвост N МБ) |
| A10 | MIN | `adapters/pi/index.ts:185-187` | Авто-компакция при `!isIdle()` молча не триггерится (debug-лог добавлен в v0.5.2 только для agent_end-ветки) | Отложить до idle или минимум notify |
| A11 | MIN | `adapters/mcp/server.ts:273` | Ответ на `notifications/*` с `id:null` (MCP запрещает); `ping` → −32601 | Нотификации — без ответа; `ping → {result:{}}` |
| A12 | MIN | `adapters/pi/index.ts:467` | `/om:recall query limit` без значения → `NaN` → молча битый результат | `Number.isFinite` + usage |
| A13 | MIN | `adapters/pi/history.ts:123-129` | `indexAfter()` пересчитывает `messages()` (полный getBranch + extraction) на каждом nextChunk/unobserved/tail/lastMessageAt — 3–5 переобхода ветки на pump (n6-класс для истории) | Мемоизация на один вызов оркестратора |
| A14 | MIN | `adapters/mcp/pi-ledger.ts:88-101` | short-read `readSync` → нули → последняя (самая свежая) om-запись corrupt → молча теряется | Цикл readSync до len/EOF |
| A15 | MIN | `adapters/pi/scoped-tools.ts:257-265` | grep по одному файлу без капа (readFileSync весь файл); read: bytes vs chars путаются (UTF-8) | Общий `readCapped()` |
| A16 | MIN | `adapters/mcp/server.ts:171-181` | `toolStatus`: 5 полных `ledger.read()` (в embedded — пере-чтение файла) | Один read + локальные фильтры |
| A17 | MIN | `adapters/pi/ledger.ts:90-94` vs `mcp/pi-ledger.ts:112` | Разные fallback'и `at` (`e.timestamp` vs `1970-…`) для одних и тех же записей | Единый fallback в общий модуль (S3) |

### 2.3 Eval (E)

| # | Sev | Местоположение | Сценарий | Фикс (без применения) |
|---|-----|----------------|----------|----------------------|
| E1 | MAJOR (воспроизведено live) | `core/orchestrator.ts:201, 988-1001` | `pumpObservers()` зовётся только из `onTurnEnd`; `shutdown()` лишь дрейнит in-flight, **финального pump'а нет**. Если последний чанк накопился после последнего onTurnEnd-пампа (observer ещё в полёте) — хвост сессии не наблюдается. Воспроизведено: 11-й поворот (tabs/RU/race-fix) не вошёл в наблюдения; в прода: при повторном запуске re-observe спасает, но для «закончившейся» сессии память неполна | Финальный `pumpObservers()` в `shutdown()` перед drain (и/или после commit observer'а) + eval-кейс tail-гонки |
| E2 | MED | eval-кейсы | Нет кейсов: gap-markers, cross-lingual recall (survival меряется substring'ом, а не `recallSearch()` — слепое пятно RU/EN), tail-гонка, idempotency consolidator, extractors-значения (asOf/sourceIds) | Добавить кейсы (см. §5) |
| E3 | MED (данные) | `eval/report.json` | `cost=$0.000` у локальной модели — метрика стоимости не измерима; нет wall-time в отчёте | Wall-time в отчёт; cost-модель с ценами для замеров |

## 3. Dead code (D)

| # | Что | Где |
|---|-----|-----|
| D1 | `core/ledger/serialize.ts` **целиком (100 строк)** — envelope v/data не использует ни FileLedgerStore (свой parseLine), ни PiLedgerStore (свой payloadOk); только тесты. 3 расходящихся payload-валидатора + «версионирование» на словах | src/core/ledger/serialize.ts |
| D2 | `maxObsId`, `compareObsIds` (progress.ts:31-45) — нет вызывающих | core/progress.ts |
| D3 | `nextObsSeqAt` (ids.ts:27-38) — только тесты; оркестратор reimplement'ил `maxSeqForSecond` | core/ids.ts + orchestrator.ts:370-382 |
| D4 | `watermark().maxSeq` / `progressOf.maxSeq` / `TombstoneReport.maxSeq` — вычисляется (вкл. слияние с tombstones), не потребляется | core/progress.ts, orchestrator.ts:827-838 |
| D5 | `EventSink.onRunFinished` — оркестратор никогда не вызывает; имплементации в adapter'е/session мерТВЫ | core/types.ts:332, adapters/pi/index.ts:213-215 |
| D6 | `Watermark.observedTokens` — всегда 0, нигде не читается | core/types.ts:222 |
| D7 | OmError-коды `'ledger-corrupt'|'storage-error'|'not-enabled'` — не конструируются | core/types.ts:338-344 |
| D8 | `renderTopicFile` — только тесты (topic-файлы пишет сам воркер) | core/memory-store.ts:230-241 |
| D9 | re-export `newRunId` из gap-markers — нет импортеров | core/gap-markers.ts:84 |
| D10 | `SanitizeResult.text` — потребитель берёт только {quarantined, matched} | core/sanitize.ts:38-42 |
| D11 | `tokens.ts:30-33` — недостижимый `if (isBoundary) continue` (конец итерации) | core/tokens.ts |
| D12 | `estimateTokensOf` — только тесты; `PoolOptions` — интерфейс без потребителей | core/tokens.ts:41, core/ledger/pool.ts:38 |
| D13 | `tests/fixtures/mocks.ts:18 identityEstimate` — не импортируется | tests |
| D14 | `q!` (vllm-конфиг с dummy-ключом), `graft/` — untracked, не gitignored; `package-lock.json` застрял на 0.5.1 | repo root |
| D15 | drain «already dead»-ветка (runner.ts:312-313) — мёртвый код (процесс уже удалён из `active`) или нужна пометка почему возможен | adapters/pi/runner.ts |

## 4. Структурные кандидаты (S)

| # | Что | Детали |
|---|-----|--------|
| S1 | **orchestrator.ts (1012 строк) — вынос RunManager** | `trackTask/runWorker(63 строки — самый длинный метод)/handleCommitFailure/recordRun/summarizeWorkerResult` + quiescent-drain, **дублирующийся в `runCompaction` и `shutdown`** (один `drainInFlight()`) — ~180 строк, одна ответственность (LLM-run lifecycle + NFR-1). Плюс шаблон «flag + runWorker + finally flag=false» 4× (consolidator/extractor/reflector/observer) → `runRoleWorker(role, flag, input, commit)`; `maybeConsolidate`/`forceConsolidate` дублируют 15 строк input-конструкции → `startConsolidation(oldestIds)` |
| S2 | **runner.ts — role-таблица** | Role→{prompt, model, render, parse, toResult} таблица вместо 4× parse/finish-блоков в close (:226-270) + ternary-цепочек (`promptFor/modelFor/workerDirFor`) — режет ~80 строк и убирает `?? consolidatorModel` ×2 |
| S3 | **Единая payload-валидация** | `payloadOk` (pi/ledger.ts) + `parseLine` (file-store.ts) + `parse` (serialize.ts) — 3 копии switch по 7 типам → один `validatePayload(type, data)` в `core/ledger/payload.ts` (core у pi и mcp в зависимостях — mcp-изоляция не ломается; закрывает A17) |
| S4 | **index.ts (адаптер, 511 строк) — разбивка** | `resume.ts` (~70), `ui.ts` (~40), `sink.ts` (~80), `boot.ts` (~80), `commands.ts` (~140), `recall-tool.ts` (~40); остаток index = вайринг `pi.on` (~70) |
| S5 | **scoped-tools — `walkDir()`** | Один walk в `ls` (:172-188) и `grep` (:222-243) + line-matching в двух ветках → `walkDir(base, {maxDepth, onFile, onDir})` + `grepFile(full, re, push)` |
| S6 | **Общий `worker-env.ts`** | `OM_WORKER`/`OM_WORKER_DIR` литералы в runner.ts:168-170 и worker.ts:14-15 — контракт на комментах |
| S7 | **Конфиг: убрать `compaction.topKBudgetTokens`** | В topK-режиме эффективный лимит = min(topKBudgetTokens, maxCompactBlockTokens) — правило «maxCompactBlock на оба режима» задокументировано только комментарием README:166. Минус 1 ключ + 1 неявная min |
| S8 | **Типы адаптера** | (а) `PiModelRef` (types.ts:101-103) — пустой интерфейс, удалить; (б) `mode` добавить в `PiContext` (diagUi кастует); (в) типизация `WorkerInput` — discriminated union по role вместо `input.chunk?/input.pool?` уберёт 4 throw'а в prompts; (г) опционально: devDep на pi-пакет + typecheck-only conformance-тест типов (дройт падает на CI, runtime чист) — структурные типы оставить (осознанное решение, дрифта на 0.87.1 не найдено; комментарий «verified vs 0.86.1» устарел) |
| S9 | **core/testing.ts в публичном `./core`** | DemoHistory в production-экспорте (осознанно, examples) — либо subpath `./core/testing`, либо examples-only |
| S10 | **eval/run.ts — pi-зависимость** | «agent-agnostic» self-eval импортит `PiSubprocessRunner` и требует `pi`-бинарник — декларируй в ARCHITECTURE §10; `dist-scripts` компилирует весь src вторым таргетом (import `../src/...`) — можно импортировать из dist |
| S11 | **Тестовые фикстуры** | `settle/sleep/makeRunner/makeOrch` переопределены в 5-6 интеграционных файлах → `tests/fixtures/mocks.ts` |
| S12 | **resolveConfig: производные дефолты** | Re-derivation «если не задан явно» через mergeDeep (explicit undefined неотличим) — хрупко; вычислять всегда при отсутствии ключа в partial |

## 5. Prompts и eval (детали)

### Прогон (qwen3.8-27b-fp8, 5 кейсов)
survival **0.95** (25/26 фактов), poison **0/12 leaks**, компрессия 1.54–2.74× (long-compaction: 0.89× — блок 840t при пороге 700t: при большом пуле компакция НЕ сжимает). 2 failed:
- `release notes` — **артефакт кейса**: факт в ~95t хвосте < chunkTokens(150) — chunker хвост не эмитит (нарушено правило кейса «facts out of the last ~150 tokens»).
- `tabs` — (а) E1 tail-гонка (воспроизведено: 2-й чанк не пампнулся); (б) промпт: мягкие preference без «remember» первыми режутся при 12-капе.

### Правки промптов (кандидаты, не применены)
- **observer**: (1) язык вывода: «Write each observation in the dominant language of the slice; keep identifiers/paths/values verbatim»; (2) P0-кап: explicit-remember «always [P0], не учитываются в капе 2–3»; (3) «no plans for the future» → «pending/blocking states are facts: record as 'waiting for X'»; (4) P1 явно: «stylistic/workflow preferences (indentation, comment language) are P1, record even when unstressed»; (5) секреты: «token-shaped / >20 random chars — never include, even in error messages». Сейчас: противоречие «at most 2-3 P0» vs «EVERY explicit remember as separate [P0]», «no plans» двусмысленно, парсер прощает прозу (абзац ≤2000 → 1 routine-наблюдение, P0-маркировка сгорает), константы 12 (промпт) vs 24 (парсер).
- **consolidator**: (1) «superseded: <old> -> <new> (date only if present in observations)» — сейчас дата требовалась, но в пуле её нет; (2) idempotency: «before writing, read target; if batch already merged — report consumed without rewriting» (сейчас: retry после side effects = двойной JOURNEY-append); (3) JOURNEY: сжатие старейших сегментов в одно предложение, но named entities/paths/decisions — never drop.
- **reflector**: no-op-протокол («topics: none, journey_changed: false»); merge: «copy unique fact sentences VERBATIM, reword only connectors».
- **extractor**: `asOf` нечем заполнить — пул подаётся `[id] content` без дат → давать `[id] (YYYY-MM-DD) content` (из id).

### RU/EN (подтверждено по recall.ts)
BM25: точные токены `[a-zа-яё0-9_\-\.]{2,}`, EN+RU stoplist, **без stemming/транслита/синонимов**: «таймзона» ≠ "timezone". Варианты (рекомендация 1+3):
1. Язык наблюдений = язык сессии (правка observer) — самый дешёвый эффект.
2. Транслитерация в токенизаторе — слабый вариант (не решает перевод).
3. Детерминированный двуязычный словарь частотных терминов (timezone/таймзона/часовой пояс, release notes/заметки о релизе, password/пароль, …) на query+doc-токены — детерминированно, без LLM.
4. Долгосрочно: опциональный LLM-rewrite запроса в /om:recall (адаптер), ядро не трогать.

### Добавления в eval-кейсы (E2)
gap-markers; cross-lingual recall через `recallSearch()` (не substring); tail-гонка (E1); idempotency consolidator'а; extractors-значения (asOf/sourceIds); injection из user-turn; утечка при password rotation; wall-time в отчёт (E3).

## 6. Docs (F)

| # | Файл | Что устарело |
|---|------|--------------|
| F1 | README:81 | `@v0.5.1` → v0.5.4 |
| F2 | README:298 | «209 тестов» → 292 |
| F3 | README:316 | `npm run build → eval/run.js` → `build:scripts → dist-scripts/eval/run.js` |
| F4 | ARCHITECTURE.md:30 | `Role = observer\|consolidator` → 4 роли |
| F5 | ARCHITECTURE.md §5.3 (270-272) | 5 команд; нет /om:extract, /om:recall, /om:reflect, /om:seed-from, тула om_recall |
| F6 | ARCHITECTURE.md §6 (283-302) | layout: нет mcp/pi-ledger.ts, tsconfig.build.scripts.json; ссылка на доки pi 0.86.1 |
| F7 | ARCHITECTURE.md | нет v0.5-фич целиком: caps (poolHardCapTokens/maxCompactBlockTokens), resumeAfterMidRunCompaction, M4 crash-repair, M5 MCP-источник; §10 кончается на v0.4 |
| F8 | REQUIREMENTS.md:145-148 | `ExtractorHook`/`ActivationPolicy` не существуют (реально ExtractorSpec/EarlyActivationConfig); «Scope v2» уже реализован — нет пометки done |
| F9 | REQUIREMENTS.md:153 | exports: нет `./adapters/mcp` |
| F10 | roadmap.md journal | строки 105–134 год «2025-09» → 2026-09; нет строк v0.5.2–v0.5.4 (а134e45, 844d628, c4141a5, 901dfb8, 43deb9a); строка 142 дублирует 140 |
| F11 | eval/run.ts:93 | default `claude-sonnet-4-6` против политики n11 (осознанно, но задокументировать) |

## 7. Приоритизованный план работ (предложение)

**Волна 1 — баги, влияющие на прода (короткие фиксы):**
1. R1 `begin = startIdx` (1 строка + тест).
2. E1 финальный pump в shutdown (3-5 строк + тест + eval-кейс).
3. A1 reset Runtime при session_shutdown reason new/resume/fork (+тест второго session_start).
4. A4 killTree в drain-watchdog + unref (2 строки + тест).
5. A2/A3 MCP: tail-read + сверка session-id (один фикс-проход pi-ledger.ts).
6. R2 gap-markers: правильный интервал (переписать maybeMarkGap + тест на реальном тайминге).

**Волна 2 — тихие баги и данные:**
R3 (idempotent-коммит), R6, R7, R8, R9, A5 (async хук + drainForCompaction), A6 (whitelist settings), A8-A9 (runner-буферы), A12, A14, A15, A11.

**Волна 3 — структура (рефакторинг без изменения поведения, каждый пункт отдельно):**
S1 RunManager, S2 role-таблица runner, S3 payload-валидация (+решение по D1 serialize.ts: удалить envelope), S4 разбивка index.ts, S5 walkDir, S6 worker-env, S7 минус topKBudgetTokens, S8 типы, S11 фикстуры. Dead code D2–D15 — чистка одним проходом.

**Волна 4 — качество состава:**
Промпты (observer-язык, P0-кап, consolidator-idempotency, extractor-dates), RU/EN (наблюдения в языке сессии + словарь-мост), eval-кейсы E2 + wall-time.

**Волна 5 — docs:** F1–F11 одним проходом.

Оценка: волны 1+2 — день работы (короткие точечные фиксы + тесты); волна 3 — 1–2 дня (рефакторинг с зелёными 292 тестами как страховкой); волны 4+5 — день.
