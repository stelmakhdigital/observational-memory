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
