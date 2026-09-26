# PROJECT_MEMORY — Observational Memory (agent-agnostic core + pi adapter)

> Файл для передачи контекста между сессиями/тредами. Обновляется по ходу проекта.

## 1. Цель проекта

Написать **полноценное расширение (библиотеку + адаптеры)** для Observational Memory (OM):

- Ядро **НЕ завязано на конкретного агента** (agent-agnostic).
- Реализуется **адаптер для pi** (pi-coding-agent), чтобы агент pi мог использовать OM.

Источники-референсы:
- https://github.com/amosblomqvist/pi-observational-memory — реализация для pi (типовая архитектура).
- https://mastra.ai/docs/memory/observational-memory — концепция OM в Mastra (Observer/Reflector, плотный лог наблюдений).

## 2. Что такое Observational Memory (суть концепции)

Проблема: «context rot» и «context waste» — сырая история сообщений в контексте снижает
качество LLM и жжёт токены.

Решение: фоновые агенты (Observer + Reflector/Consolidator) сжимают старую историю в
**плотные атомарные наблюдения (observations)**. Старая сырая история заменяется этим логом
в блоке компакции. Наблюдения:
- append-only, кэшируемы (стабильный префикс промпта → prompt caching, дешевле);
- заменяют шумные tool calls и нерелевантные токены;
- сохраняются между сессиями (долгая память).

Ключевые свойства (синтез из обоих источников):
1. **Observer**: при превышении порога токенов новой истории режет фиксированный слайс и
   дистиллирует его в наблюдения. observers параллельны (чистые мапперы).
2. **Observation**: `{ timestamp/id, content, tokenCount }` — атомарная заметка.
3. **Буфер/леджер наблюдений**: append-only пул; детерминированная рендеризация в
   «compaction block» (model-free, без LLM).
4. **Consolidator/Reflector**: при превышении пула порога склеивает **старейшие** наблюдения
   в долговременные тематические файлы (`.memory/<session>/<topic>.md`), буфер возвращается
   к целевому размеру. Один за раз (последовательно).
5. **Journey**: единое описательное прозаическое описание истории работы над проектом
   (JOURNEY.md), append-mostly, сжимается по старым сегментам.
6. **Cost tracking**: стоимость фоновых LLM-вызовов аккумулируется и отображается.
7. В Mastra дополнительно: extractors (извлечение структурированных значений, e.g. профиль
   пользователя), temporal gap markers, early activation (idle/provider change).

## 3. Архитектурный разбор референса (pi-observational-memory)

Пайплайн:
```
raw chunks (token-bounded slices)
  → parallel observers (subprocess, headless pi)
  → observations {timestamp, content}
  → master ledger (branch-local)
  → compaction block (deterministic, model-free render)
  → consolidator (subprocess, one at a time)
  → .memory/<sessionId>/<topic>.md + INDEX.md + JOURNEY.md (durable, per-session)
```

Структура репо референса:
- `src/` — оркестратор (master side):
  - `index.ts` — entry,
  - `config.ts` — конфиг (chunkTokens, poolTargetTokens, consolidateAtPoolTokens,
    compactAtContextTokens, tailTokens, journeyTargetTokens, observerConcurrency,
    models {observer, consolidator}, passive, debugLog),
  - `hooks/` — observer-trigger, consolidator-trigger, compaction-trigger, compaction-hook,
  - `ledger/` — types, pool, progress (watermarks coversUpToId), projection, fold, render, serialize,
  - `memory/` — paths, session (seed from parent on fork), index-render,
  - `spawn/` — launch, runs (subprocess + IPC через файлы в .runs/),
  - `commands/` — status, compact, consolidate,
  - `ui/` — status-controller, timeline,
  - `tokens.ts`, `ids.ts`, `runtime.ts`, `debug-log.ts`
- `agent/` — worker-расширение (грузится в subprocess через `-e`, OM_WORKER=observer|consolidator):
  - observer/prompt.ts + tool.ts, consolidator/prompt.ts + tools.ts, cost.ts, index.ts
- `tests/` — vitest; `npm test`, `npm run typecheck`.

Ключевые механизмы референса:
- Observers: параллельные, каждый коммитит свой watermark `coversUpToId` — порядок не важен.
- Compaction: `agent_end` при `contextTokens > compactAtContextTokens` (idle): ждёт
  in-flight observers, рендерит активный буфер + memory map (front-matter тем) + JOURNEY.md;
  cutoff снапится на границу чанка наблюдений (verbatim tail не дублируется).
- Consolidator: при pool > consolidateAtPoolTokens; складывает старейшие (выше
  poolTargetTokens) в тематические файлы; orchestrator tombstone'ит отчётные наблюдения.
- Тематические файлы per-session (immutable session id), НЕ откатываются при /tree;
  fork seed'ит память от родителя.
- Workers — обычные headless-сессии pi (auditable), IPC через result-файлы
  (`.memory/<session>/.runs/<runId>.cost.json` и наблюдение).
- Cost: `usage.cost.total` из pi; суммируется по всем веткам (не откатывается).

## 4. Поверхность адаптера pi (pi-coding-agent 0.86.1)

Источники: docs/extensions.md, docs/sessions.md, docs/settings.json, docs/packages.md.

Доступные события (нужные для OM):
- `session_start`, `session_info_changed`, `session_before_fork`, `session_before_tree` /
  `session_tree`, `session_shutdown`
- `before_agent_start`, `agent_start`, `agent_end`, `agent_settled`
- `turn_start` / `turn_end`
- `message_start` / `message_update` / `message_end`
- `tool_execution_start/update/end`, `tool_call`, `tool_result`
- `before_provider_request` / `after_provider_response` (usage/cost)

Методы ExtensionAPI:
- `pi.on(event, handler)`, `pi.registerCommand(name, {description, handler})`,
  `pi.registerTool(definition)`, `pi.registerFlag`, `pi.registerShortcut`
- `pi.appendEntry(customType, data?)` — запись custom-entries в session ledger
  (кандидат на хранение ledger-записей OM branch-локально),
- `pi.registerEntryRenderer(customType, renderer)`, `pi.registerMessageRenderer`
- `pi.sendMessage / pi.sendUserMessage`, `pi.exec(command, args, options?)`
- `pi.events` (event bus)
- UI: widgets/status/footer (см. Custom UI, «Widgets, Status, and Footer»)

ExtensionContext:
- `ctx.sessionManager` (доступ к записям сессии, история сообщений), `ctx.cwd`
- `ctx.model`, `ctx.modelRegistry`, `ctx.thinkingLevel`
- `ctx.getContextUsage()`, `ctx.compact()` (принудительная компакция),
- `ctx.getSystemPrompt()`, `ctx.isIdle()`, `ctx.abort()`, `ctx.shutdown()`
- CommandContext: `ctx.waitForIdle()`, `ctx.newSession()`, `ctx.fork(entryId)`,
  `ctx.navigateTree(targetId)`, `ctx.switchSession(path)`

Конфиг: `~/.pi/agent/settings.json` (global) и `.pi/settings.json` (project),
неймспейс расширения (в референсе: `observational-memory`).

Worker'ы в pi: headless-запуск `pi` через `pi.exec` / child_process
(в референсе — subprocess pi с `-e agent/index.ts`, `OM_WORKER=observer|consolidator`).

## 5. Целевая архитектура (черновик, уточнить в фазе Design)

```
observational-memory/
├── core/          # agent-agnostic ядро (TS-библиотека, публичный API)
│   ├── types.ts         # Observation, Chunk, LedgerEntry, RunReport, ...
│   ├── config.ts        # ResolvedConfig + defaults + merge
│   ├── tokens.ts        # token estimation (fast, без LLM)
│   ├── chunker.ts       # разбивка истории на token-bounded slices
│   ├── ledger/          # append-only пул, watermarks, projection, render (model-free)
│   ├── orchestrator.ts  # clocks: observer/consolidator/compaction, concurrency pool
│   ├── memory-store.ts  # durable files: <root>/<sessionId>/<topic>.md, INDEX.md, JOURNEY.md
│   ├── runner.ts        # интерфейс ModelRunner (execute worker run)
│   ├── prompts/         # prompt-шаблоны observer/consolidator (agent-agnostic)
│   └── cost.ts          # cost accounting
├── adapters/
│   └── pi/        # адаптер для pi-coding-agent (pi extension)
│       ├── index.ts     # точка входа расширения: события → orchestrator
│       ├── session.ts   # маппинг session/branch, fork-seed, appendEntry-ledger
│       ├── runner.ts    # ModelRunner через headless subprocess pi (pi CLI)
│       ├── commands.ts  # /om, /om:status, /om:compact, /om:consolidate
│       └── ui.ts        # status widget / footer
├── tests/           # vitest (core) + smoke (adapter)
├── package.json     # workspaces или единый пакет с exports
└── docs/
```

Ключевые интерфейсы ядра (черновик):
- `ModelRunner.run(role: 'observer'|'consolidator', input: WorkerInput): Promise<WorkerResult>`
- `HistorySource` (getNewMessagesSince(watermark), estimateTokens)
- `EventSink` (onCompactionBlock(block), onStatusChange(...))
- `MemoryRoot` (storage abstraction: файлы vs DB)

## 6. Соглашения по работе (процесс, PMBOK/SDLC)

- Фаза: сейчас **Discovery** (PMBOK: Initiating → Requirements).
- `roadmap.md` — все задачи/этапы, отмечать по мере выполнения.
- `AGENTS.md` — справочник для ИИ-агентов по проекту.
- Перед каждым шагом — todo-план на русском; каждый пункт отмечать,
  сообщать промежуточные результаты.
- Обязательные пункты в любом todo: «Компиляция и тестирование»,
  «Получить разрешение от пользователя на коммит».
- Коммит ТОЛЬКО после явного одобрения пользователем; после коммита
  отметить выполненные пункты в roadmap.md.

## 7. Решения и открытые вопросы

### Принято (2025-09, подтверждено пользователем)
1. **Название пакета:** `@arkalaust/observational-memory`. ✅
2. **Структура:** единый npm-пакет, TypeScript, ESM, strict, vitest; subpath exports
   `./core` и `./adapters/pi`. ✅
3. **Ledger в pi:** хранение через `pi.appendEntry` (custom entries в append-only журнале
   сессии). Переживает resume; branch-local — корректно работает при ветвлении `/tree`
   (как в референсе). Альтернатива (внешние файлы `.memory/ledger.json`) отклонена:
   ручная синхронизация веток/resume, риск рассинхрона. ✅
4. **Worker'ы:** headless subprocess `pi` (auditable — каждый воркер обычная сессия pi,
   cost из встроенного `usage.cost.total` pi). Путь к бинарнику configurable
   (`OM_PI_BIN` / setting). Альтернатива (SDK-вызовы в процессе) отклонена: нет
   аудитабельности и своего клиента LLM. ✅
5. **v1-состав:** ядро по референсу (observer / compaction block / consolidator / cost
   tracking / JOURNEY + topic files) **+ temporal gap markers** (решение 2025-09: добавить
   в v1 — в ядре генерация меток пауз, в адаптере pi — на возобновлении сессии/обращении
   после паузы ≥ порога, метка видна observer'у для временных якорей). Остальные фичи
   Mastra (extractors, early activation) — v2, в ядре — interface-задел (extension points). ✅
6. **Целевой минимальный pi-релиз:** 0.86.1 (локальная установка пользователя). ✅

### Справка: temporal gap markers (перенесено в v1)
Фича Mastra: при возобновлении диалога после паузы ≥ N минут (по умолч. 10) вставляется
метка «прошло X времени с прошлого сообщения», сохраняется в памяти и видна observer'у —
наблюдения можно якорить во времени («решение принято после 2-дневной паузы»). Для pi:
актуально при возобновлении сессии через день/неделю.

## 8. Статус

- 2025-09: фаза Discovery. Собраны требования, изучены референсы и API pi.
  Созданы PROJECT_MEMORY.md, roadmap.md, AGENTS.md.
- 2025-09: решения приняты: ledger=`pi.appendEntry`, workers=subprocess `pi`,
  gap-markers перенесены в **v1**, v1 = observer/compaction/consolidator/cost + gap-markers.
- 2025-09: глобальное разрешение пользователя на коммиты — после каждого шага
  коммит выполняется без дополнительного вопроса (фиксация от 2025-09).
- 2025-09: создан `docs/REQUIREMENTS.md` (FR-1..FR-10, NFR, v1/v2, риски, критерии
  приёмки) — фаза Discovery закрыта.
- 2025-09: создан `docs/ARCHITECTURE.md` (Planning): слои, модель данных, швы
  (ModelRunner/HistorySource/LedgerStore/EventSink/MemoryRoot), оркестрация, адаптер pi,
  ошибки, тест-стратегия, WBS §9 (9 спринтов), спайки S1/S2.
- 2025-09: Sprint 1 (Implementation) выполнен: skeleton пакета (@arkalaust/observational-memory,
  exports ./core, ./adapters/pi), core types/config/ids, unit-тесты (12 passed), typecheck чистый.
- 2025-09: Sprint 2 выполнен: tokens (estimateTokens, быстрая эвристика без LLM) +
  MessageChunker (token-bounded slices по границам сообщений, watermark, overlap,
  re-observe при неизвестном watermark после /tree). Тестов: 26 passed.
- 2025-09: Sprint 3 выполнен: ledger — pool (fold, tombstones, oldestAbove), progress
  (watermark = max coversUpToId, out-of-order safe, survives tombstones), render
  (детерминированный model-free compaction block, cutoff selectBeforeTail — нет
  двойного представления), serialize (versioned envelopes, null on corrupt).
  Тестов: 45 passed. Важные решения: watermark — MESSAGE id; id наблюдений
  lexicographically ordered (seq scoped to second, nextObsSeqAt).
- 2025-09: Sprint 4 выполнен: memory-store (MemoryStore: session-директории, topic
  files с front-matter, INDEX.md render, JOURNEY, one-time fork-seed без .runs;
  parseFrontMatter/renderTopicFile/renderMemoryMap), gap-markers (detectGap,
  humanDuration с русской плюрализацией, renderGapMarkers), cost (sumCosts по всем
  веткам, skip невалидных). Тестов: 64 passed.
- 2025-09: Sprint 5 выполнен: prompts (observer — атомарные наблюдения, строгий
  формат OBSERVATIONS/END_OBSERVATIONS; consolidator — CONSOLIDATION_REPORT с
  topics/journey_changed/consumed/dropped) + worker-output.ts (детерминированные
  lenient-парсеры: строгий блок → bullets → bare paragraph; мусор → ok=false).
  Тестов: 77 passed.
- 2025-09: Sprint 6 выполнен: OmOrchestrator — gate (setEnabled/restoreEnabled, fork-seed),
  observer pump (dedup pendingChunks — один observer на слайс, watermark двигается
  только после коммита), consolidator (serial, force), gap-markers (один на паузу),
  compaction (drain → block → sink), retry-once + om.lastError, status, shutdown.
  Ключевые решения/фиксы: WorkerResult.observations — string[] (id/tokenCount
  генерит оркестратор); watermark переживает tombstones через метаданные
  (maxCoversUpToId/maxSeq); tail boundary = последнее сообщение НЕ в хвосте,
  '' = хвост покрывает всё (наблюдения не рендерятся).
  Тестов: 88 passed (10 файлов, вкл. интеграцию пайплайна на MockRunner).
- 2025-09: Sprint 7 выполнен: adapter pi — loadPiAdapterConfig (settings.json global+project,
  env OM_PI_BIN/OM_WORKER_TIMEOUT_MS), PiHistorySource (entry id = uuidv7, messageText),
  PiLedgerStore (pi.appendEntry('om', …), payloadOk-валидация), PiSubprocessRunner
  (pi -p --mode json --model, parsePiJsonl: text+cost.total, timeout → finish сразу,
  drain), index.ts (session_start/turn_end/agent_end/session_before_compact/
  session_shutdown, команды /om /om:status /om:compact /om:consolidate, UI setStatus,
  gap-markers → pi.sendMessage hidden). Спайки: S1 — session_before_compact
  возвращает {compaction:{summary, firstKeptEntryId (tail boundary + 1), tokensBefore}};
  S2 — custom entries branch-local, не в LLM-контексте, переживают resume.
  Известное ограничение v1: воркеры с дефолтным набором тулов (scope-hardening — v1.1).
  Тестов: 111 passed (14 файлов).
- 2025-09: Sprint 8 (частично): README.md (установка/конфиг/архитектура/ограничения),
  package.json (keywords/license), smoke-тест точки входа (default export — фабрика,
  регистрит 5 событий + 4 команды, ленивый boot). Тестов: 115 passed.
  Спринты 1–8 WBS по коду завершены; остаётся ручной smoke в реальном pi (roadmap §5).
- 2025-09: Release review (7aba3b4): мёртвый export `./adapters/pi/worker` удалён,
  ARCHITECTURE.md синхронизирован с финальным layout (фактически: 24 файла src, 2810 строк).
  Весь код WBS (спринты 1–8) + релиз-обзор завершены; typecheck 0 ошибок, 115 тестов.
- 2025-09: v1.1 scope-hardening: воркеры теперь с `--no-builtin-tools` + worker-расширением
  (`src/adapters/pi/worker.ts`, env OM_WORKER/OM_WORKER_DIR). Observer — без тулов;
  consolidator — только scoped read/write/edit/ls/grep в `.memory/<session>/`
  (scoped-tools.ts, path containment, 5 unit-тестов + runner/env-тесты; 130 passed).
  typebox добавлен в peerDependencies (pi бандлит его). Осталось: (1) ручной smoke;
  (2) v0.1.0 тег.
- 2025-09: packaging для установки через Git (a76501e): pi-манифест `pi.extensions` в
  package.json (расширение подхватывается автоматически), keyword `pi-package`,
  typebox → peerDependencies `*` (по докам pi: не бандлить), установка
  `pi install git:github.com/arkalaust/observational-memory@v0.1.0` или локальный
  путь; npm-публикации нет (решение пользователя).
- 2025-09: v2 extractors: ExtractorSpec (ид по умолч. `profile`), роль `extractor` в
  ModelRunner, prompt EXTRACTED_JSON + lenient-парсер, хранение
  `.memory/<session>/extracted/<id>.json`, триггеры: после консолидации (по
  только что консолидированным наблюдениям) и /om:extract (по активному пулу),
  cost byRole.extractor, статус extractedCount; 149 passed. Замечание: extracted/
  не копируется при fork-seed (v2-лимитация, задокументирована в тесте).
- 2025-09: **релиз v0.1.0** — версия в package.json поднята до 0.1.0, тег v0.1.0
  (согласовано с пользователем). Установка: `pi install git:github.com/arkalaust/observational-memory@v0.1.0`.
  Осталось: ручной smoke в живом pi (первый шаг после тега).
- 2025-09: **ручной smoke пройден** (реальный pi, проект ~/om-smoke, модель
  qwen3.8-27b-dflash2): 48 наблюдений (13 observer-запусков, все ok), 2
  консолидации (5 тем + JOURNEY), 3 экстракции (extracted/profile.json — высокий
  профиль), 1 компакция — OM-блок (21k) как summary c firstKeptEntryId; 0 ошибок;
  resume сессии восстановил gate/состояние из ledger. Cost $0.000 — ожидаемо:
  локальный провайдер без ценника (cost записывается только при > 0). Smoke-пороги
  из ~/.pi/agent/settings.json убраны (производные дефолты + модели qwen).
- 2025-09: v2 early activation + фикс fork-seed: (1) `earlyActivation {enabled,
  idleMs, minUnobservedTokens}` — досрочное наблюдение при `model_select` (pi-событие
  → orchestrator.onModelChange) и при idle (unref-таймер после turn_end);
  chunker.next(..., {minTokens}) — чанк ниже порога; (2) seedFrom теперь
  рекурсивно копирует `extracted/` (cpSync). 155 passed.
- 2025-09: репо пользователя: git@github.com:stelmakhdigital/observational-memory.git
  (remote origin добавлен; push — вручную пользователем. SSH на этой машине к
  github.com:22 рвётся после KEX — DPI; работает через ssh.github.com:443, см.
  ~/.ssh/config). Пакет переименован в @stelmakhdigital/observational-memory,
  URL установки в README/доках обновлён.
- 2025-09: **разведка рынка памяти для агентов** (GitHub, 2026-09): mem0 65.8k★ (новый
  алгоритм: single-pass ADD-only extraction, entity linking, temporal reasoning,
  бенчмарки LoCoMo 92.5 / LongMemEval 94.4, open-source eval), Graphiti/Zep 31k★
  (bi-temporal граф: факты с valid/invalid windows, invalidation не delete, hybrid
  search), cognee 30.9k★ (ECL pipeline), supermemory 30.8k★ TS/MIT (auto-forget
  устаревших фактов, contradiction resolution, 95% Recall@15 за ~720 токенов),
  Letta 24.8k★ (memory blocks + sleep-time agents — фоновая консолидация памяти,
  arXiv 2504.13171), basic-memory 4k★ AGPL (markdown+sqlite, MCP, hybrid search —
  архитектурно ближе всех к нам). Поля, отсутствующие у OM и присутствующие у лидеров:
  (1) би-темпоральность/invalidation фактов; (2) явная политика конфликтов
  (supersede, не overwrite); (3) sleep-time «reflector»-пасс; (4) retrieval по
  запросу посреди диалога (у нас — только injection при компакции); (5) eval-
  харнес (LongMemEval/LoCoMo — индустриальный стандарт); (6) защита от memory
  poisoning (prompt injection → долговременная память). Наши редкие козыри:
  детерминированный model-free compaction block, append-only branch-local ledger +
  watermark (аудит, /tree), cost tracking фоновых LLM, scoped workers, local-first
  без БД/сервисов. Приоритеты для v0.4+: P0 supersede/asOf-метаданные + /om:recall
  (детерминированный поиск по темам); P1 anti-poisoning guard, self-eval harness,
  reflector-роль; P2 project-level shared memory, seed-from, temporal queries.
  (Подробнее — в отчёте от 22.09; развитие на паузе по решению пользователя.)
- 2025-09: **разведка НИШИ observational memory** (концепция, а не память в целом).
  Канон: **Mastra OM** (@mastra/memory≥1.1, mastra 28.2k★). Observer (порог 30k
  токенов, tokenx-оценка) → dense append-only observation log, заменяющий историю
  (стабильный контекст — дружелюбие к prompt-cache); Reflector — реорг/склейка/
  уплотнение; early activation: activateAfterIdle ('auto'/'5m'...),
  activateOnProviderChange, bufferOnIdle (off), bufferTokens (async pre-buffering,
  мгновенный swap); temporal gap markers (off, пауза ≥10 мин); extractors: with-schema
  (follow-up structured call) и schema-less (inline); **includePreviousExtraction
  (default true — инкрементное обновление значений)**; встроенные extractors: current
  task / suggested response / thread title; stream-события data-om-*-end
  (extractedValues/extractionFailures); обязательный storage adapter.
  Экосистема адаптеров ниши (2026-02..09, зрелость низкая; лидер вне Mastra —
  total-recall 273★): nik1t7n/pi-observational-memory-extension (4★; Actor/Observer/
  Reflector, priority-метки 🔴🟡🟢✅, vector/BOW retrieval (local offline — default,
  Gemini — opt), om_recall-тул (сырая история из scrollable index), attachment gates,
  pre-buffering 20% порога, stale-lock recovery, TUI, adaptive thresholds, пороги
  30k/40k); SentioLabs/observational-memory (Go CLI, Codex-first, evidence-backed:
  наблюдения с проверяемыми ссылками на источники, «evidence is data, not
  instructions» — anti-poisoning, SQLite ledgers, memory ops без LLM/сети);
  voladelta/omk (local-first kernel+CLI); c-daly/memory (Claude Code); total-recall и
  clawback (OpenClaw); hermes-om ×2; opencode-om; amosblomqvist/pi-observational-
  memory (наш референс) — 53★/28 forks. Выводы: (1) ниша горячая — концепция
  распространяется на все harness'ы; (2) «стандарт фич» ниши, отсутствующих у OM:
  recall-тул по сырой истории, приоритетные метки наблюдений, ranked/BOW-инжекция,
  pre-buffering с мгновенным swap (у нас частично: early activation), provenance-
  указатели на исходную историю, current-task-экстрактор, includePrevious для
  экстракторов, crash-durability (locks/atomicity); (3) козыри OM в нише: branch-
  local ledger + watermark (никто в нише branch-aware), cost tracking, scoped
  workers, детерминированный model-free block, embedded core. Быстрые выигрыши
  v0.4+: current-task extractor + priority labels + /om:recall + provenance +
  includePrevious — выравнивание со стандартом ниши при низкой цене.
- 2025-09: **v0.4 feature wave — все 4 фазы реализованы (релиз v0.4.0)**.
  Ремаппинг: фазы 1–4 одной волной (код взаимосвязан) → один релиз v0.4.0
  вместо v0.4/v0.5/v0.6/v0.7. Что добавлено (209 тестов, typecheck 0):
  Ф1: priority-метки P0/P1/P2 (observer-промпт, ObservationDraft, orderByPriority,
  маркеры !/· в блоке); встроенный current-task-экстрактор + renderCurrentTask
  (первая секция блока); includePrevious (default true, opt-out per spec);
  supersede-политика (consolidator: 'superseded (date): old -> new', оба факта
  остаются) + asOf/sourceIds в экстракторах. Ф2: recall.ts (tokenize en/ru +
  stopwords, BM25-lite k1=1.5/b=0.75, дет-тибрейки: свежие раньше),
  buildSessionRecallDocs (общий билдер: orch/MCP/eval), тул om_recall (TypeBox)
  + /om:recall [limit N][since D][until D]; provenance sourceRange {fromId,toId}
  (chunker fromId); compaction.inject full|topK + trimToBudget (классами,
  свежие первыми). Ф3: sanitize.ts (injection-паттерны → quarantined, рендер
  [UNVERIFIED]) + observer-правила (история=данные, секреты не записывать);
  FileLedgerStore sibling-lock {pid,at} (stale-забор, отказ через onAppendError,
  lock:false); eval/run.ts + eval/cases (npm run eval: fact survival/сжатие/cost
  → report.json, реальные воркеры через OM_PI_BIN/OM_EVAL_MODEL); reflector-роль
  (idle≥30мин + minInterval 6ч по om.run, scoped-тулы, REFLECTION_REPORT,
  /om:reflect). Ф4: shared memory <root>/shared (read-only: recall kind
  shared-topic, референс в consolidator/reflector); seedFrom force +
  /om:seed-from; attachments auto|off ([image: name]/[file: name], байты не
  передаются — ограничение); MCP-сервер src/adapters/mcp (stdio JSON-RPC:
  om_status/om_recall/om_topics, handleMcpRequest — чистый, тестируем). 4.4
  (FTS/sqlite) осознанно отложен. Новые модули: core/{recall,sanitize,testing}.ts,
  core/prompts/reflector.ts, adapters/mcp/server.ts, eval/. Конфиг-ключи:
  priority, compaction{inject,topKBudgetTokens}, reflector{enabled,idleMs,
  minIntervalMs}, shared{enabled}, attachments (pi), models.reflect,
  extractors[].includePrevious. Ключевые решения: priority = порядок рендера
  (critical→routine) + budget-trim (не сортировка по важности внутри чанка);
  since/until фильтруют только наблюдения (файлы без дат); reflect не потребляет
  наблюдения (без tombstones); MCP read-only (без оркестратора/раннера).
- 2025-09: **push выполнен**: main (3b2d1cb) + тег v0.1.0 → github.com:stelmakhdigital/observational-memory.
  Корень проблемы SSH: права на ~/.ssh/id_ed25519 были 0664 (chmod 600) + агент SSH держит
  ключ в locked-состоянии. Обход зашит в ~/.ssh/config: Host github.com →
  ssh.github.com:443, IdentityFile + IdentitiesOnly (без агента). Установка в pi теперь:
  `pi install git:github.com/stelmakhdigital/observational-memory@v0.1.0`.
  Тег v0.1.0 стоит на 806bc1f (до early activation); early activation + fork-seed-fix
  (3b2d1cb) пойдут в v0.2.0.
- 2025-09: v2+ embedded-интеграция: `FileLedgerStore` (JSONL append-only, corrupt-
  устойчивый, append не крэшит хост — NFR-1) + `createOmSession()` (конвейер
  root/sessionId/history/runner → оркестратор+память+ledger) + `examples/embedded-demo.ts`
  (`npm run demo`, tsc build в dist/). Заодно починено: (a) seed-триггер теперь по
  seed-флагу, а не по exists(dir) (FileLedgerStore заранее создавал dir — seed
  пропусcalся); seedFrom → boolean; (b) quiescent shutdown/compaction: follow-up
  воркеры (post-consolidation extraction) дожидаются (inFlight-записи удаляются
  при завершении, trackTask). 165 passed.
- 2025-09: **АУДИТ (26.09)** — полная проверка: typecheck OK, 209/209 тестов, live smoke
  в pi 0.87.1 (qwen3.8-27b-fp8) — пайплайн рабочий (29 obs, консолидации, supersede,
  extractors, recall, reflector; 0 крашей). Код-ревью: **1 критичный** (C1: getEntries()
  вместо getBranch() — порожение памяти при /tree) + 6 major (M1 drain-race hang, M2
  мусорные worker-сессии, M3 без hard cap пула, M4 FileLedgerStore lock, M5 MCP не видит
  pi-ledger, M6 dups при retry) + 11 minor. Референс amosblomqvist (MIT, замер 25.08):
  мы функционально богаче; перенять: auto-resume после mid-run компакции,
  canSkipObserverWait, cutoff-snap, cost «по всем веткам», runs≠cost>0. Рекомендации
  P0/P1/P2 — в `audit.md` (локальный, gitignored). Smoke: `/om:compact` в headless
  не персистится (проверить в TUI). Подробности — audit.md.
- 2025-09: **Фиксы P0 (аудит 26.09) — все 4 критичных/major-фикса выполнены, 239 тестов, typecheck чисто**:
  (1) C1: getEntries()→getBranch() во всех 4 местах (history.messages/lastMessageAt, ledger, firstBranchEntryIdAfter)
  — мёртвые ветки больше не порождают память/контекст; n9: дедуп re-observe по sourceRange.fromId в foldPool
  (последний run с тем же fromId вытесняет ранние; legacy id-dedupe сохранён). (2) M1: drain() переписан
  (close-хэндлеры первыми, watchdog min(timeout,60s) — hang невозможен) + killTree (detached + kill -pid),
  n1 (data-слушатели снимаются), n3 (timer.unref). M2: воркеры с `--no-session` (проверено живьём: 0 мусорных
  сессий). (3) M3: poolHardCapTokens (60k = 3×consolidateAt, производные дефолты) + maxCompactBlockTokens
  (40k = min(0.4×compactAt, cap)) — trimToBudget применяется ВСЕГДА (full = «пул, но ≤ бюджета»);
  invariant-тест «контекст после ≤ до». (4) n11: models.* дефолт = пустая строка = «наследовать модель хоста»
  (resolveWorkerModel при boot); runs-счётчик: om.cost пишется при каждом воркере (вкл. $0) → status.runs честный.
  Найден и починен латентный баг теста topK (общий ledger-файл двух сессий).
  Осталось: M4/M5/M6 (P1), перенос механизмов референса (P1.7), интерактивный smoke авто-компакции (P2.13).
- 2025-09: **Фиксы M6 + n10 + n4 + n5 (аудит 26.09), 260 тестов, typecheck чисто**:
  (1) M6: commit-ошибка ≠ worker-ошибка — runWorker ретраит ТОЛЬКО коммит (1 раз, синхронно, без LLM);
  при окончательном падении коммита LLM-результат сохраняется в om.lastError (тексты наблюдений),
  слайс НЕ помечается покрытым (watermark не двигался) → re-observe в следующем цикле, n9-dedup
  страхует от дублей при частичном коммите. OmError: новый код 'commit-failed'. (2) n10: parsePiJsonl
  собирает ВСЕ non-empty assistant-тексты (multi-turn), pickReportBody берёт последний (с конца),
  PARSE-ABLE-ся парсером роли; fallback — последний non-empty как раньше. (3) n4: resolveContained
  + realpath существующего префикса (для write-цели — realpath родителя + сегмент), re-check containment
  по реальным путям; walks ls/grep не следуют symlink'ам за пределы real root.
  (4) n5: grep-лимиты (500 файлов, 2MB суммарно, 100 совпадений) + правило «простые regex» в prompt
  consolidator'а. Residual risk (catastrophic backtracking одного regex) остаётся — полная защита
  только worker-thread timeout (P2).
- 2025-09: **Фиксы P1 (аудит 26.09) — выполнены, 278 тестов, typecheck чисто**:
  (1) M5: MCP читает pi-session JSONL напрямую (adapters/mcp/pi-ledger.ts: readPiLedger —
  type='custom'/customType='om', scanForPiSession top-50 по mtime; приоритет OM_MCP_PI_SESSION →
  скан → embedded; source-поаметка в om_status; read-only). (2) M6: retry ТОЛЬКО коммита
  (1 раз, без повторного LLM-вызова); при окончательном падении — lastError с сохранённым
  LLM-результатом (тексты наблюдений), слайс не покрыт → re-observe (n9-dedup страхует дубли).
  (3) n10: parsePiJsonl собирает ВСЕ non-empty assistant-тексты + pickReportBody (последний
  парсящийся отчёт). (4) n4: scoped-tools — realpath префикса + walk не следует за symlink'ами.
  (5) n5: grep-лимиты (500 файлов / 2MB / 100 совпадений) + правило «простые regex» в prompt.
  (6) Порт референса: auto-resume после авто-компакции при stopReason length/non-retryable error
  (runEndedUnfinished + hidden om-resume triggerTurn, конфиг resumeAfterMidRunCompaction default true);
  canSkipObserverWait — дрейн компакции пропускает observers с fromId > tailBoundary (слайс в tail);
  **cutoff-snap: найдена реальная дыра** (чанк, пересекающий tail-границу, выпадал и из блока, и из tail)
  — фикс: снап raw-границы назад на закоммиченный конец чанка (min |tail−target|), инвариант
  «∅ пересечение, ∪ = вся история» покрыт тестом; JOURNEY-prompt: добавлен запрет «end of session»-языка.
- 2025-09: **Фиксы P2 + релиз v0.5.0 (26.09)**: (1) M4 FileLedgerStore — O_EXCL-lock,
  re-check на append, commit = O_APPEND + fsync, crash-repair (partial-строка → onRepair(lineNo)
  + repairCount, не молча); (2) n6 — in-memory индекс (нет readFileSync на каждый вызов);
  (3) P2.12 packaging: exports/types → собранный dist (tsconfig.build, rootDir src), prepare:
  npm run build, files [dist, src] (pi git-install — src, не тронут), consumer-проверено: tarball
  → чистый Node ESM; eval/examples → dist-scripts; (4) P2.14 README-дефолты синхронизированы.
  289 тестов (31 файл), typecheck чисто. Ручные P2.13/15 (TUI-smoke авто-компакции, gap-markers/
  reflect живьём) — пользователю (в audit.md). Release **v0.5.0**: P0+P1+P2 волна фиксов
  (критичный C1 ветвление, 6 major, 4 механизма референса, packaging).
- 2026-09: **Fix install → v0.5.1 (тег не поставлен — пользователь поставит)**:
  `pi install git:...@v0.5.0` падал: pi ставит через `npm install --omit=dev` →
  devDependencies не ставятся → `prepare` → `tsc: not found` (exit 127). Фикс:
  typescript + @types/node (tsconfig `"types": ["node"]`) → dependencies; typebox
  убран из devDependencies (был peer+dev: npm считал peer выполненным devDep и
  при --omit=dev не ставил → tsc не находил типы typebox; как чистый peer "*"
  авто-ставится npm 7+ и в prod-режиме). Live-проверено: (a) npm pack →
  чистая папка `npm install <tarball> --omit=dev` → import /core OK;
  (b) git clone → `npm install --omit=dev` → prepare → tsc → dist, import OK.
  packaging.test.ts: инвариант «dependencies пуст» заменён на
  «dependencies = ровно [@types/node, typescript]». 289 тестов, typecheck чисто.
- 2025-09: **v0.2.0** (тег 3982f98): early activation + fork-seed fix в релизе;
  установка в pi переключена с локального пути на
  `git:github.com/stelmakhdigital/observational-memory@v0.2.0` (settings.json,
  pi поставит пакет при следующем старте). Локальная разработка теперь требует
  `pi update --extensions` / сдвиг тега для прогона изменений.
