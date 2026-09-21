# ARCHITECTURE — `@stelmakhdigital/observational-memory`

Версия 1.0 · Фаза: Planning · Требования: `docs/REQUIREMENTS.md` (FR-*)

## 1. Слои и правило зависимостей

```
┌────────────────────────────────────────────────────────────┐
│ adapters/pi          pi-extension: события, /om*, UI,      │
│                      subprocess-воркеры, settings          │
│        реализует интерфейсы ядра, не меняет его             │
├────────────────────────────────────────────────────────────┤
│ core (публичный API: ./core)                               │
│  оркестратор · ledger · chunker · tokens · render ·        │
│  memory-store · prompts · cost · gap-markers · config      │
├────────────────────────────────────────────────────────────┤
│ (зависимости наружу: только Node APIs; никаких импортов    │
│  adapters/*; все LLM-вызовы — через ModelRunner)           │
└────────────────────────────────────────────────────────────┘
```

Правило: `core/` НЕ импортирует `adapters/*` и ничего pi-специфичного.
Агент-специфичное поведение — только внедрением реализаций интерфейсов.

## 2. Модель данных (core/types)

```ts
type Role = 'observer' | 'consolidator';

interface Observation {
  id: string;            // unique, second-resolution, re-derived at commit (см. ids)
  coversUpToId: string;  // watermark: история обработана до этого message-id
  content: string;       // атомарная заметка
  tokenCount: number;
  createdAt: string;     // ISO timestamp события
}

type LedgerEntryType =
  | 'om.observation' | 'om.tombstone' | 'om.cost'
  | 'om.gap-marker' | 'om.enabled' | 'om.run';

interface LedgerEntry {
  type: LedgerEntryType;
  data: unknown;         // типизованные payloads (Observation, TombstoneReport, CostEntry, ...)
  at: string;            // ISO
  meta?: { runId?: string; branchId?: string };
}

interface CostEntry { runId: string; role: Role; usd: number; at: string; }

interface GapMarker { id: string; at: string; humanDuration: string; } // «2 дня 3 часа»

interface CompactionBlock {
  observations: string;  // детерминированный вербальный рендер пула
  memoryMap: string;     // из front-matter тематических файлов
  journey: string;       // JOURNEY.md verbatim
  verbatimTail: string;  // свежая история, снапс на границу чанка
  generatedAt: string;
}

// воркеры
interface WorkerInput {
  runId: string; role: Role;
  chunk?: { text: string; overlapContext: string; coversUpToId: string }; // observer
  pool?: { observations: Observation[]; sessionDir: string; journey: string }; // consolidator
}
interface WorkerResult {
  runId: string; ok: boolean; error?: string;
  observations?: Observation[];            // observer
  consolidation?: { topics: string[]; tombstoneIds: string[]; journeyChanged: boolean }; // consolidator
  costUsd?: number;
}
```

## 3. Интерфейсы ядра (швы интеграции)

```ts
// LLM-вызовы. Реализации: PiSubprocessRunner (adapters/pi), MockRunner (tests)
interface ModelRunner {
  run(role: Role, input: WorkerInput): Promise<WorkerResult>;
  drain?(): Promise<void>; // дождаться завершённости in-flight (для graceful shutdown)
}

// история сообщений агента (адаптер знает формат сессии)
interface HistorySource {
  nextChunk(since: Watermark): { text: string; overlapContext: string; coversUpToId: string; tokens: number } | null;
  currentTokens(): number;        // оценка токенов контекста (для compact-триггера)
  isIdle(): boolean;
  tailVerbatim(sinceId: string, maxTokens: number): string;
  lastMessageAt(): Date | null;   // для gap-markers
}

// append-only хранилище ledger. Реализации: PiAppendEntryStore (adapters/pi, branch-local),
// FileLedgerStore (фолбэк/spike R1)
interface LedgerStore {
  append(entry: LedgerEntry): void;
  read<K extends LedgerEntryType>(type?: K): TypedLedgerEntry<K>[]; // текущая ветка
  tombstone(ids: string[]): void;
}

// события наружу (UI, адаптер)
interface EventSink {
  onStatus(s: OmStatus): void;
  onCompactionBlock(b: CompactionBlock): void; // адаптер передаёт в ctx.compact()/инъекцию
  onRunStarted(run: RunInfo): void; onRunFinished(run: RunInfo, r: WorkerResult): void;
  onError(e: OmError): void;
}

// долгие файлы <root>/<sessionId>/*.md
interface MemoryRoot {
  sessionDir(sessionId: string): string;
  exists(sessionId: string): boolean;
  seedFrom(parentSessionId: string, sessionId: string): void; // один раз, при fork
  listTopics(sessionId: string): TopicSummary[];  // front-matter
  readJourney(sessionId: string): string;
  renderIndex(sessionId: string): void; // владение оркестратора
}
```

## 4. Компоненты core и потоки данных

### 4.1 Orchestrator (главная точка входа ядра)

```ts
class OmOrchestrator {
  constructor(deps: {
    config: ResolvedConfig;
    history: HistorySource;
    ledger: LedgerStore;
    runner: ModelRunner;
    memory: MemoryRoot;
    sink: EventSink;
    clock?: { now(): Date };   // для тестов
  });
  setEnabled(on: boolean): void;      // gate (FR-7.2), пишется в ledger om.enabled
  onTurnEnd(): void;                  // observer clock + consolidator clock (FR-1.1, FR-4.1)
  onAgentEnd(): void;                 // compaction check (FR-3.1), gap-marker check (FR-8.1)
  forceCompact(): Promise<void>;      // FR-3.5
  forceConsolidate(): Promise<void>;  // FR-4.6
  compactBlock(): CompactionBlock;    // FR-3.2/3.3
  status(): OmStatus;
  shutdown(): Promise<void>;          // drain воркеров (NFR-1)
}
```

Потоки:
```
onTurnEnd:
  1) observer clock: пока nextChunk() даёт чанк и пул воркеров < concurrency →
     spawn observer (ModelRunner.run) → коммит наблюдений (ledger.append,
     coversUpToId из результата) → cost entry
  2) consolidator clock: poolTokens > consolidateAtPoolTokens && нет активного
     consolidator'а → serial queue → ModelRunner.run(consolidator) →
     tombstone(отчётные ids) → renderIndex
onAgentEnd (idle):
  1) gap-marker: now - lastMessageAt >= gapThresholdMs → ledger.append(om.gap-marker)
  2) compaction: currentTokens >= compactAtContextTokens → ждать in-flight observers
     → compactBlock() → sink.onCompactionBlock
```

### 4.2 Ledger (append-only пул)

- `Pool`: активные наблюдения = observations − tombstones (детерминированный fold).
- `Progress`: максимальный `coversUpToId` по наблюдениям = watermark чанкера;
  out-of-order завершение observers не ломает прогресс (watermark — max, а не last).
- `Projection`: порядок рендера = порядок коммита, группировка по чанкам.
- `Render` (model-free): `[obs id/timestamp] content` + разделитель; суммарные
  tokenCount; cutoff снапится на границу чанка (FR-3.4).
- `Serialize` (для LedgerStore payloads): versioned JSON, миграции forward-only.

### 4.3 Chunker + Tokens

- `estimateTokens(text)` — быстрая эвристика (chars/4, каллибруется; без LLM) (FR-2.2/NFR-5).
- `chunker.next(since, chunkTokens, overlap)` — режет по токенам на границах
  сообщений (не рвёт сообщение пополам), отдаёт `coversUpToId` последнего сообщения
  в слайсе.

### 4.4 MemoryStore (MemoryRoot fs-реализация в core)

- Layout: `<project>/.memory/<sessionId>/{INDEX.md, JOURNEY.md, <topic>.md, .runs/}`.
- Fork-seed: при первом обращении к новому sessionDir, если задан parentId —
  рекурсивное копирование (один раз, флаг в INDEX meta) (FR-4.4).
- Тематические файлы: front-matter `topic/description/session`, markdown body.
- JOURNEY: append-mostly сегменты `## <дата> — <заголовок>`; при > journeyTargetTokens
  consolidator сжимает старейшие (FR-5).

### 4.5 Prompts

- `prompts/observer.md`, `prompts/consolidator.md` — шаблоны (agent-agnostic),
  подстановка chunk/pool; требования к атомарности наблюдений, формата вывода.
- Формат вывода воркера — структурный (markdown с явными секциями), парсер в core
  (детерминированный, тестируется без LLM).

### 4.5.1 Extractors (v2, Mastra-style)

- `ExtractorSpec { id: [a-z0-9_-]{1,64}, name, description }`; конфиг `extractors` (по
  умолч. один `profile`), `extractors: []` — выключить. Модель `models.extractor` (по
  умолч. = consolidator).
- Триггеры: после успешной консолидации — по **только что консолидированным**
  наблюдениям (пул уже tombstoned) + ручной `/om:extract` — по активному пулу.
- Воркер возвращает строгий JSON-блок (EXTRACTED_JSON), lenient-парсер
  `parseExtractorOutput`; значения складываются в `.memory/<session>/extracted/<id>.json`.
- Cost экстрактора учитывается в общем cost (byRole.extractor); статус: extractedCount.

### 4.5.2 Early activation (v2, Mastra-style)

- Конфиг `earlyActivation { enabled, idleMs, minUnobservedTokens }` (дефолт: true / 5 мин / 300).
- Триггеры: (1) `model_select` (адаптер → `orchestrator.onModelChange()`) — смена
  модели/провайдера сбрасывает промпт-кэш, поэтому накопленная ненаблюдаемая история
  (≥ minUnobservedTokens) обрабатывается досрочно; (2) idle: после `turn_end`
  ставится таймер idleMs (unref), по срабатывании — если сессия в простое и
  ненаблюдаемых токенов ≥ min — один early-чанк.
- Механика: `chunker.next(..., { minTokens })` — тот же слайс, но с пониженным
  порогом; observer обычный (watermark/pendingChunks-dedup/ретраи — без изменений).

### 4.6 Gap markers (FR-8)

- `GapMarkerDetector.check(lastAt, now, thresholdMs)` → опциональный GapMarker.
- Метка сохраняется в ledger (`om.gap-marker`) и рендерится в head compaction block
  и в контекст observer'а («session resumed after 2 days»).

### 4.7 Cost

- `CostAccountant.total()` = сумма всех `om.cost` entries по ledger (все ветки)
  (FR-6.2) — никогда не уменьшается.

## 5. Адаптер pi (adapters/pi)

### 5.1 Маппинг событий

| pi-событие | Действие адаптера |
|---|---|
| `session_start` | инициализация (session id, fork-parent, seed памяти, чтение om.enabled из ledger) |
| `turn_end` | `orchestrator.onTurnEnd()` + планирование idle early-activation |
| `model_select` | `orchestrator.onModelChange()` (early activation, v2) |
| `agent_end` | `orchestrator.onAgentEnd()` |
| `session_shutdown` | `orchestrator.shutdown()` (drain) |
| (пер-сессионное состояние) | gate off → все вызовы no-op (FR-7.2) |

### 5.2 Реализации интерфейсов

- `PiHistorySource`: из `ctx.sessionManager` (история сообщений, текущий контекст,
  `ctx.isIdle()`), `currentTokens` из `ctx.getContextUsage()`.
- `PiLedgerStore`: `pi.appendEntry('om', {type, data})` — branch-local, переживает
  resume (решение §7.3 PROJECT_MEMORY). Чтение — из записей сессии.
- `PiSubprocessRunner` (ModelRunner): headless `pi -p --mode json --model <pattern> 
  --no-extensions -- <prompt>`; бинарник: `piBinary` / `OM_PI_BIN` (решение §7.4).
  Выход — JSONL-события; `parsePiJsonl` извлекает финальный assistant-текст и
  cost из `usage.cost.total`; таймаут (workerTimeoutMs) → резкий finish + SIGKILL.
  Парсинг ответа — lenient-парсеры core (worker-output.ts).
  **Scope-hardening (v1.1, готово):** воркеры запускаются с `--no-builtin-tools -e 
  src/adapters/pi/worker.ts` (env `OM_WORKER=observer|consolidator`, `OM_WORKER_DIR`):
  observer — без тулов (чистый маппер), consolidator — только scoped read/write/edit/
  ls/grep с containment в session-каталог (scoped-tools.ts, без bash/сети).
- `EventSink` → UI: `ctx.ui.setStatus('om', …)` (cost, пул), `ctx.ui.notify` (ошибки/статусы),
  gap-markers → `pi.sendMessage({customType:'om', display:false})` (hidden context anchor).
- Compaction (S1): `session_before_compact` → `{compaction: {summary: block.text,
  firstKeptEntryId: <первая запись после tail boundary>, tokensBefore}}` — OM-блок
  становится summary компакции (model-free). Триггер: onAgentEnd (порог контекста)
  → `ctx.compact()`, а также ручные `/compact` и `om:compact`.

### 5.3 Команды и UI (FR-7)

`/om [on|off]`, `/om:status`, `/om:compact`, `/om:consolidate` — через
`pi.registerCommand` (реализованы в `index.ts`); конфиг — `observational-memory`
в settings.json (FR-9).

### 5.4 Спайки (выполнены в Sprint 7, подтверждено по .d.ts/докам pi 0.86.1)

- S1 (решено): OM-блок → `session_before_compact` возвращает `compaction.summary`
  + `firstKeptEntryId` (tail boundary).
- S2 (решено): `pi.appendEntry` — CustomEntry как дочка текущего leaf: branch-local,
  не участвует в LLM-контексте, переживает resume — ledger-хранилище корректно.

## 6. Файловый лэйаут (цель)

```
package.json            name: @stelmakhdigital/observational-memory, exports ./core ./adapters/pi
tsconfig.json  vitest.config.ts
src/core/types.ts  config.ts  tokens.ts  chunker.ts  ids.ts  worker-output.ts
src/core/ledger/{index,pool,progress,render,serialize,file-store}.ts
src/core/memory-store.ts  gap-markers.ts  cost.ts  session.ts (createOmSession)
src/core/prompts/{observer,consolidator,extractor}.ts
src/core/orchestrator.ts  index.ts (public API)
examples/embedded-demo.ts  (npm run demo: полный пайплайн без pi/LLM)
src/adapters/pi/{index.ts,history.ts,ledger.ts,runner.ts,worker.ts,scoped-tools.ts,config.ts,types.ts}
tests/unit/*  tests/integration/*  tests/fixtures/*
docs/{REQUIREMENTS,ARCHITECTURE}.md  README.md
```

## 7. Обработка ошибок (NFR-1)

- Сбой воркера: `om.run` entry со статусом error, `om.lastError` в статусе, ретраит ≤1
  (наблюдение не теряется — watermark не двигается до успешного коммита).
- Повреждённый ledger payload: skip + warn в debug log (append-only не чинится на месте).
- Конфиг невалиден: бросаем при инициализации с понятным сообщением (FR-9.3).
- Master-сессия никогда не блокируется воркерами: все LLM-вызовы async (NFR-5).

## 8. Тест-стратегия (NFR-7)

- Unit (без LLM): tokens, chunker, pool/fold/tombstones, render/determinism,
  progress watermarks, gap-markers, cost, worker-output parser, config merge/инварианты,
  memory-store (temp dir).
- Интеграция: пайплайн на MockModelRunner: chunk→observations→pool→consolidate→tombstones
  →compact block; fork-seed; off-gate (нулевые эффекты).
- Smoke (в pi): acceptance criteria §8 REQUIREMENTS (ручной чек-лист).

## 9. Спринты (WBS, детализация шагов — в roadmap §3–4)

1. Skeleton: package.json/tsconfig/vitest + types + config (+тесты).
2. tokens + chunker (+тесты).
3. ledger: pool/progress/projection/render/serialize (+тесты).
4. memory-store + gap-markers + cost (+тесты).
5. prompts + worker-output parser (+тесты).
6. orchestrator + интеграция на MockRunner (+тесты).
7. Adapter pi: config/history/ledger/UI/commands (S1, S2 спайки).
8. Adapter pi: subprocess runner + worker (+smoke).
9. README, полировка, v0.1.0.
