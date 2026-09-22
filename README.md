# observational-memory

Agent-agnostic **Observational Memory (OM)** для LLM-агентов + готовый адаптер для
**pi-coding-agent**.

OM решает проблему *context rot* и *context waste* в длинных сессиях: фоновые
**observers** дистиллируют сырую историю диалога в атомарные **наблюдения**, которые
детерминированно рендерятся в **блок компакции** (заменяя старую историю), а
**consolidator** склеивает старейшие наблюдения в долговременные тематические файлы.

- Концепция: Observer/Reflector по образцу [Mastra Observational Memory](https://mastra.ai/docs/memory/observational-memory)
  и архитектуры [pi-observational-memory](https://github.com/amosblomqvist/pi-observational-memory)
  (написано с нуля, без копирования кода).
- Ядро **не знает** о конкретном агенте: агент-специфичное внедряется через интерфейсы
  (`ModelRunner`, `HistorySource`, `LedgerStore`, `EventSink`, `MemoryRoot`).

## Возможности

- **Observers** — параллельные фоновые воркеры (чистые мапперы), режут token-bounded
  слайсы истории и коммитят атомарные наблюдения; завершаются в любом порядке
  (watermarks `coversUpToId`).
- **Приоритеты наблюдений (v0.4)** — observer размечает `critical/important/routine`
  (P0/P1/P2): в блоке компакции важное — сверху, при давлении бюджета (режим
  `topK`) triviales отбрасываются первыми.
- **Provenance (v0.4)** — каждое наблюдение несёт диапазон исходной истории
  (`sourceRange: fromId→toId`): recall/аудит указывают на источник.
- **Anti-poisoning (v0.4)** — детерминированный санитайзер quarantined-отмечает
  наблюдения с injection-подобным содержанием (`[UNVERIFIED]` в блоке); observer
  проинструктирован не записывать инструкции/секреты как факты.
- **Compaction block** — детерминированный (model-free) рендер: current task +
  наблюдения (по приоритету) + memory map (front-matter тем) + journey +
  verbatim-хвост. В pi используется как summary компакции (`session_before_compact`).
  Режимы инъекции: `full` (весь пул) и `topK` (детерминированный приоритетный
  бюджет).
- **Current task (v0.4)** — встроенный экстрактор `current-task`: текущая задача,
  pending, следующий шаг; всегда первой секцией компактного блока — агент не
  теряет нить после компакции.
- **Consolidator** — последовательный воркер; складывает старейшие наблюдения в
  `.memory/<session>/<topic>.md` (+ `INDEX.md`, `JOURNEY.md`), буфер возвращается
  к целевому размеру (tombstones). Политика **supersede, не overwrite**:
  противоречие → явная пометка «старое → новое (дата)», оба факта остаются.
- **Journey** — описательная прозаическая история работы, append-mostly, вставляется
  в каждый compaction block для ориентации.
- **Recall (v0.4)** — детерминированный BM25-lite поиск по памяти (наблюдения,
  темы, journey, экстракторы) **посреди диалога**: тул `om_recall` для самого
  агента + команда `/om:recall <query> [limit N] [since DATE] [until DATE]`.
  Без LLM, без векторов, без БД.
- **Shared memory (v0.4)** — project-level темы в `<root>/shared/` (read-only):
  попадают в recall и как референс в consolidator; ручной seed из другой сессии —
  `/om:seed-from <sessionId>`.
- **Gap markers** — временные якоря при возобновлении сессии после паузы (по умолч. ≥ 10 мин).
- **Cost tracking** — стоимость фоновых LLM-вызовов (все роли), суммируется по
  всем веткам (никогда не уменьшается при `/tree`), видна в статусе.
- **Extractors (v2)** — именованные структурированные значения (по умолч. `profile`
  и `current-task`), обновляются после консолидации; **includePrevious** (по
  умолч. true): экстрактору показывается старое значение → инкрементальное
  обновление (опция `includePrevious: false` — volatile-значения). Хранение
  `.memory/<session>/extracted/<id>.json`, форсинг — `/om:extract`.
- **Early activation (v2)** — наблюдение «раньше порога» при смене модели
  (`model_select`, промпт-кэш всё равно сброшен) и при тишине пользователя ≥ idleMs
  (буфер наполняется, пока мы ждём). Настраивается в `earlyActivation`.
- **Reflector (v0.4, sleep-time)** — редкий фоновый воркер (idle ≥ 30 мин, не чаще
  раза в 6 ч): реорганизация тем (merge/rename), сжатие JOURNEY, перенос устаревшего
  в «History». Редкий и rate-limited; форсируется `/om:reflect`.
- **Безопасные воркеры** — observer без тулов; consolidator/reflector — только
  scoped `read/write/edit/ls/grep` в своём session-каталоге памяти.
- **Gate по умолчанию OFF** — расширение невидимо, пока не включить (`/om on`).

## Установка

Требуется Node.js ≥ 20 и **pi ≥ 0.86.1**.

```bash
# из этого репозитория
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (без LLM)
```

### Подключение к pi

Установка **через Git** (pi-пакет, манифест `pi.extensions` в package.json — расширение
подхватывается автоматически):

```bash
pi install git:github.com/stelmakhdigital/observational-memory@v0.4.0   # тег
pi install /абсолютный/путь/к/observational-memory               # локальный каталог
pi -e /абсолютный/путь/к/observational-memory                    # один раз, без установки
pi remove git:github.com/stelmakhdigital/observational-memory          # удалить
```

pi клонирует репозиторий и запускает `npm install` в клоне (runtime-зависимостей нет;
typebox — peerDependency, поставляется самим pi).

Альтернатива (ручная, без установки пакета): в `~/.pi/agent/settings.json`:
```json
{ "extensions": ["/абсолютный/путь/к/observational-memory/src/adapters/pi/index.ts"] }
```

После установки доступны команды: `/om`, `/om:status`, `/om:compact`, `/om:consolidate`,
`/om:extract`, `/om:recall`, `/om:reflect`, `/om:seed-from` и тул `om_recall`
(агент ищет в памяти сам, посреди диалога).

## Использование

```
/om on            # включить OM для этой сессии (gate по умолчанию off)
/om:status        # пул, consolidator, темы, journey, контекст, стоимость, ошибки
/om:compact       # форсированная компакция через OM-блок
/om:consolidate   # форсированная консолидация (фоновая)
/om:extract       # форсированное обновление экстракторов (фоновое)
/om:recall <query> [limit N] [since DATE] [until DATE]   # поиск по памяти (детерминированный)
/om:reflect       # форсированный sleep-time пропуск реорганизации памяти (фоновый)
/om:seed-from <sessionId>   # разовый seed памяти из другой сессии (force, без перезаписи)
/om off           # выключить
```

Повседневный сценарий: `/om on` в начале длинной сессии. Observers работают сами
на `turn_end`; при росте контекста компакция автоматически использует OM-блок;
пул наблюдений периодически консолидируется в долгие файлы. Если агенту нужен
старый факт/решение, которого нет в видимом контексте, он сам вызывает тул
`om_recall` (или пользователь — `/om:recall`).

## Конфигурация

Неймспейс `observational-memory` в `~/.pi/agent/settings.json` (global) и
`.pi/settings.json` (project, переопределяет global):

```jsonc
{
  "observational-memory": {
    "chunkTokens": 5000,           // токенов новой истории на observer-чанк
    "chunkOverlapTokens": 0,       // overlap-контекст для связности
    "poolTargetTokens": 10000,     // целевой размер буфера после консолидации
    "consolidateAtPoolTokens": 20000, // порог запуска консолидации
    "compactAtContextTokens": 100000, // порог контекста для компакции (тонировать под модель)
    "tailTokens": 20000,           // verbatim-хвост (снапится на границу чанка)
    "journeyTargetTokens": 1000,   // целевой размер JOURNEY.md
    "observerConcurrency": 4,
    "models": {
      "observer":     { "id": "claude-sonnet-4-6", "thinking": "low" },
      "consolidator": { "id": "claude-sonnet-4-6", "thinking": "medium" },
      "extractor":    { "id": "claude-sonnet-4-6", "thinking": "low" },
      "reflect":      { "id": "claude-sonnet-4-6", "thinking": "low" } // опц., по умолч. = consolidator
    },
    "extractors": [                    // пустой список [] — выключить экстракторы
      { "id": "profile",
        "name": "User profile & preferences",
        "description": "Stable facts about the user and their preferences...",
        "includePrevious": true },     // опц.: показывать старое значение (инкремент), по умолч. true
      { "id": "current-task",
        "name": "Current task & next steps",
        "description": "The CURRENT state of the work..." }
    ],
    "priority": { "enabled": true },   // v0.4: priority-метки наблюдений (P0/P1/P2)
    "compaction": { "inject": "full", "topKBudgetTokens": 20000 }, // "full" | "topK"
    "reflector": { "enabled": true, "idleMs": 1800000, "minIntervalMs": 21600000 },
    "shared": { "enabled": true },     // v0.4: project-level темы <root>/shared (read-only)
    "attachments": "auto",             // "auto" (плейсхолдеры [image: name]) | "off"
    "passive": false,              // power-user: только ручные команды (для теста /tree)
    "debugLog": false,
    "gapMarkers": { "enabled": true, "thresholdMs": 600000 },
    "earlyActivation": { "enabled": true, "idleMs": 300000, "minUnobservedTokens": 300 },
    "piBinary": "pi"               // бинарник для воркеров (или env OM_PI_BIN)
  }
}
```

Переменные окружения: `OM_PI_BIN` (бинарник pi), `OM_WORKER_TIMEOUT_MS` (таймаут воркера).

### MCP-сервер (любой MCP-клиент, v0.4)

Read-only доступ к памяти сессии из любого MCP-клиента (Claude Code, Codex, свой
хост) — «дёшево» закрыть адаптер под чужого агента:

```bash
OM_MCP_ROOT=<memory root> OM_MCP_SESSION=<sessionId> npm run mcp
# инструменты: om_status, om_recall (query/limit/since/until), om_topics
```

Транспорт — JSON-RPC 2.0 over stdio (MCP-протокол: initialize/tools/list/tools/call).
Публичный экспорт: `@stelmakhdigital/observational-memory/adapters/mcp`.

## Встраивание в свой агент (без pi)

Ядро агент-независимое: реализуй два шва — `HistorySource` (история твоей сессии)
и `ModelRunner` (LLM-вызовы: subprocess, in-process SDK, что угодно) — и получай
всё остальное одним вызовом:

```ts
import { createOmSession, type HistorySource, type ModelRunner } from
  '@stelmakhdigital/observational-memory/core';

const session = createOmSession({
  root: path.join(projectDir, '.memory'), // долгие файлы + ledger.jsonl
  sessionId: mySessionId,
  history: myHistory,      // HistorySource
  runner: myRunner,        // ModelRunner (observer/consolidator/extractor)
  // config: { chunkTokens, ... } — опционально, валидируется
});
session.orchestrator.setEnabled(true);
// на конце хода: session.orchestrator.onTurnEnd();
// при компакции:  session.orchestrator.compactBlock().text — твоя новая история
```

- ledger — `FileLedgerStore` (JSONL, append-only, corrupt-устойчивый), gate/
  watermark переживают рестарт процесса; sibling-lock (`ledger.jsonl.lock`) защищает
  от записи двумя процессами (stale-locks забираются автоматически);
- ручные триггеры — `forceConsolidate()` / `forceExtract()` / `forceCompact()` /
  `forceReflect()`;
- **recall без LLM** — `session.orchestrator.recall(query, { limit, since, until })` /
  `recallText(...)` — BM25-lite по наблюдениям, темам, journey, экстракторам;
- `DemoHistory` (экспорт из `./core`) — минимальная in-memory история для тестов/eval;
- пример без LLM: `npm run demo` (`examples/embedded-demo.ts`);
- self-eval (с реальным LLM): `npm run eval` — выживаемость ключевых фактов после
  observe→consolidate→extract, сжатие, стоимость (env `OM_EVAL_MODEL`, `OM_PI_BIN`).

## Архитектура

```
raw chunks (token-bounded)
  → parallel observers (headless `pi -p --mode json`; priority P0/P1/P2, provenance)
  → observations {id, coversUpToId, content, priority, sourceRange, quarantined?}
  → ledger (append-only, branch-local: pi.appendEntry / ledger.jsonl)
  → compaction block (deterministic, model-free: current task → по приоритету → topK-бюджет)
  → consolidator (headless, one at a time; supersede-политика)
  → .memory/<session>/<topic>.md + INDEX.md + JOURNEY.md (durable) + shared/
  → extractors (headless, after consolidation; includePrevious) → extracted/<id>.json
  → reflector (sleep-time, редкий) — реорг тем/JOURNEY
  → recall (BM25-lite, детерминированный) — om_recall тул / /om:recall / MCP
```

Слои: `src/core` (agent-agnostic, публичный API `./core`) → `src/adapters/pi`
(`./adapters/pi`) → `src/adapters/mcp` (`./adapters/mcp`). Правило: `core` не
импортирует `adapters`; все LLM-вызовы — через `ModelRunner`. Подробности — в
`docs/ARCHITECTURE.md`, требования — в `docs/REQUIREMENTS.md`.

## Тестирование

### Слои без LLM (быстро, токены не расходуются)

```bash
npm test          # 209 тестов (vitest)
npm run typecheck # tsc --noEmit
npm run demo      # полный пайплайн в "чужом" агенте, без LLM/pi (скриптованный runner)
```

| Слой | Что проверяется | Токены |
|------|-----------------|--------|
| **Unit: core** | tokens/chunker (слайсы, watermark), ledger (pool fold, tombstones, `trimToBudget`/`orderByPriority`, render-детерминизм), memory-store (темы, INDEX, fork-seed, shared, seed-from force), gap-markers, cost, **парсеры worker-output** (observer с P0/P1/P2-тегами, consolidation, extractor, reflection), config (merge/инварианты), sanitize (injection-паттерны), recall (tokenize/BM25/since/until), FileLedgerStore (corrupt-строки, lock) | нет |
| **Unit: pi-адаптер** | config (settings merge), history (entry→text, attachment gates), ledger (appendEntry), scoped-tools (path containment), worker (роли), **runner на РЕАЛЬНОМ subprocess с фейковым pi-бинарником** (JSONL-парсинг, cost, env OM_WORKER, timeout), entry-smoke (хендлеры/команды/тул om_recall) | нет |
| **Интеграция: пайплайн** | на MockRunner: chunk → observations (priority/provenance/quarantine) → pool → consolidate → tombstones → compact block (current-task, topK-бюджет), экстракторы (includePrevious), reflector (interval), recall (orchestrator), shared/seed | нет |
| **MCP** | JSON-RPC-диспетчер (initialize/tools/call) без транспорта | нет |

Все воркеры в тестах — `MockRunner` / фейковый pi-бинарник, поэтому CI и локальный
`npm test` токены не расходуют.

### Self-eval (`npm run eval`) — с реальным LLM, токены расходуется

Единственная команда проекта, расходующая токены. Назначение: **регрессионный
контроль качества памяти** — промпты (observer/consolidator/extractor/reflector)
это фактический «модельный слой» проекта, и eval измеряет, что он реально выдаёт.

Как работает:
1. `npm run build` → запуск `eval/run.js`;
2. читает скриптовые сессии из `eval/cases/*.json`: список реплик диалога
   (`turns`) + `expectedFacts` — ключевые факты, которые обязаны выжить;
3. прогоняет каждый кейс через **полный реальный пайплайн**: observers →
   consolidation → extractors (настоящие subprocess-воркеры через `pi -p`,
   модель из `OM_EVAL_MODEL`);
4. пишет отчёт: `eval/report.json` + консольный отчёт с ✓/✗ по каждому факту
   и списком слоёв, где он найден.

Метрики:

| Метрика | Что значит | Как читать |
|---------|-----------|------------|
| **facts x/y** (fact survival) | доля ключевых фактов кейса, **найденных в памяти** (наблюдения + темы + JOURNEY + extracted) после всего пайплайна | Главный показатель качества: 1.0 = ничего не потеряно. Промах = реальный разрыв (промпт/модель/пороги) — смотреть, в каких слоях факт не найден |
| **obs N** | сколько наблюдений сформировано observers'ами | Sanity: N > 0 — observers сработали; N = 0 — баг порогов/воркера |
| **topics N** | сколько долговременных тематических файлов создал consolidator | Для малых кейсов 0–2 нормально; 0 при N > 0 — consolidator ничего не записал |
| **A→B tokens (×C)** | токены сырой истории (A) → токены памяти (B); C = A/B | C > 1 — память плотнее истории (компрессия). Для **малых** кейсов C < 1 — норма (фиксированный оверхед тем/JOURNEY/extracted превышает историю); компрессия проявляется в длинных сессиях |
| **$ cost** | стоимость всех фоновых LLM-вызовов кейса (наблюдения + консолидация + экстракторы) | На локальной модели — 0.000; на облачной — ориентир для бюджета «стоимость памяти за сессию» |

Интерпретация и правила:
- **Вариативность модели**: локальная модель (и любой LLM) даёт разбег от прогона
  к прогону (иногда создаёт тему, иногда нет; порядок фактов). Сравнивать eval
  нужно **от прогона к прогону на той же модели**, а не с «идеалом».
- **Если survival упал после изменений**: (1) откатить правки промптов
  (`git stash`) и прогнать — восстановилось = регрессия в промпте;
  (2) открыть `report.json` и посмотреть, в каких **слоях** факт потерян
  (observation? topic? extracted?) — это укажет на виноватого воркера;
  (3) точечно ужесточить промпт (правила «потерь нет»/supersede уже есть у
  consolidator).
- **Когда запускать**: после правок `src/core/prompts/*`, `worker-output.ts`,
  chunker/порогов конфига, смены модели воркеров.
- **Baseline** (22.09.2026, `qwen3.8-27b-dflash2` локально, cost $0.000):
  **7/7 + 4/6 = 84%**; промахи — «русский язык» (факт не записан) и «reports»
  (название модуля потеряно) — честные разрывы, не артефакты кейса.

Env-параметры eval:

```bash
OM_EVAL_MODEL=qwen3.8-27b-dflash2 npm run eval  # модель всех воркеров (по умолч. claude-sonnet-4-6)
OM_PI_BIN=...                 # бинарник pi для subprocess-воркеров (по умолч. pi)
OM_EVAL_OBSERVER=...          # отдельная модель observer'а (опц.)
OM_EVAL_CONSOLIDATOR=...      # отдельная модель consolidator/extractor/reflector (опц.)
OM_EVAL_VERBOSE=1             # лог запусков/сбоев воркеров в stderr
```

Как расширить: добавить свой кейс в `eval/cases/<id>.json` (turns + expectedFacts)
— подхватывается автоматически, новый кейс не требует правок кода.

## Известные ограничения

- Воркеры запускаются с `--no-builtin-tools` + worker-расширением: observer **без
  тулов** (чистый маппер), consolidator/reflector — **только scoped**
  `read/write/edit/ls/grep` в пределах `.memory/<session>/` (path containment,
  без bash/сети).
- Вложения: observer видит именованные плейсхолдеры (`[image: name]`, `[file: name]`)
  — сами image-байты в текстовых воркеры не передаются (gate `attachments`: `auto`/`off`).
- Поисковый слой — детерминированный BM25-lite (токенизация + stopwords), без
  эмбеддингов и sqlite-индекса: на масштабах кодинг-агентов (темы + пул наблюдений)
  этого достаточно; при росте — FTS/sqlite-индекс (см. roadmap v2+).
- `estimateTokens` — эвристика (chars/4 + densification), достаточно точная для
  порогов (±10–20%).

## Лицензия

MIT.
