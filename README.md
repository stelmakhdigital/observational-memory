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
- **Compaction block** — детерминированный (model-free) рендер: наблюдения +
  memory map (front-matter тем) + journey + verbatim-хвост. В pi используется как
  summary компакции (`session_before_compact`).
- **Consolidator** — последовательный воркер; складывает старейшие наблюдения в
  `.memory/<session>/<topic>.md` (+ `INDEX.md`, `JOURNEY.md`), буфер возвращается
  к целевому размеру (tombstones).
- **Journey** — описательная прозаическая история работы, append-mostly, вставляется
  в каждый compaction block для ориентации.
- **Gap markers** — временные якорь при возобновлении сессии после паузы (по умолч. ≥ 10 мин).
- **Cost tracking** — стоимость фоновых LLM-вызовов (включая экстракторы),
  суммируется по всем веткам (никогда не уменьшается при `/tree`), видна в статусе.
- **Extractors (v2)** — именованные структурированные значения (по умолч. `profile`:
  профиль и предпочтения пользователя), обновляются после консолидации по
  только что консолидированным наблюдениям; хранение `.memory/<session>/extracted/<id>.json`.
  Настраиваются/отключаются в `extractors`, форсируются командой `/om:extract`.
- **Early activation (v2)** — наблюдение «раньше порога» при смене модели
  (`model_select`, промпт-кэш всё равно сброшен) и при тишине пользователя ≥ idleMs
  (буфер наполняется, пока мы ждём). Настраивается в `earlyActivation`.
- **Безопасные воркеры** — observer без тулов, consolidator с доступом только к
  своему session-каталогу памяти.
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
pi install git:github.com/stelmakhdigital/observational-memory@v0.1.0   # тег
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

После установки доступны команды: `/om`, `/om:status`, `/om:compact`, `/om:consolidate`, `/om:extract`.

## Использование

```
/om on            # включить OM для этой сессии (gate по умолчанию off)
/om:status        # пул, consolidator, темы, journey, контекст, стоимость, ошибки
/om:compact       # форсированная компакция через OM-блок
/om:consolidate   # форсированная консолидация (фоновая)
/om:extract       # форсированное обновление экстракторов (фоновое)
/om off           # выключить
```

Повседневный сценарий: `/om on` в начале длинной сессии. Observers работают сами
на `turn_end`; при росте контекста компакция автоматически использует OM-блок;
пул наблюдений периодически консолидируется в долгие файлы.

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
      "extractor":    { "id": "claude-sonnet-4-6", "thinking": "low" } // опц., по умолч. = consolidator
    },
    "extractors": [                    // пустой список [] — выключить экстракторы
      { "id": "profile",
        "name": "User profile & preferences",
        "description": "Stable facts about the user and their preferences..." }
    ],
    "passive": false,              // power-user: только ручные команды (для теста /tree)
    "debugLog": false,
    "gapMarkers": { "enabled": true, "thresholdMs": 600000 },
    "earlyActivation": { "enabled": true, "idleMs": 300000, "minUnobservedTokens": 300 },
    "piBinary": "pi"               // бинарник для воркеров (или env OM_PI_BIN)
  }
}
```

Переменные окружения: `OM_PI_BIN` (бинарник pi), `OM_WORKER_TIMEOUT_MS` (таймаут воркера).

## Архитектура

```
raw chunks (token-bounded)
  → parallel observers (headless `pi -p --mode json`)
  → observations {id, coversUpToId, content, tokenCount}
  → ledger (append-only, branch-local: pi.appendEntry)
  → compaction block (deterministic, model-free)
  → consolidator (headless, one at a time)
  → .memory/<session>/<topic>.md + INDEX.md + JOURNEY.md (durable)
  → extractors (headless, after consolidation) → .memory/<session>/extracted/<id>.json
```

Слои: `src/core` (agent-agnostic, публичный API `./core`) → `src/adapters/pi`
(`./adapters/pi`). Правило: `core` не импортирует `adapters`; все LLM-вызовы — через
`ModelRunner`. Подробности — в `docs/ARCHITECTURE.md`, требования — в
`docs/REQUIREMENTS.md`.

## Тестирование

```bash
npm test          # 155 тестов: unit (core + adapter) + интеграция пайплайна (без LLM)
npm run typecheck # tsc --noEmit
```

Воркеры в тестах — `MockRunner`/фейковый pi-бинарник, поэтому CI не расходует токены.

## Известные ограничения (v1)

- Воркеры запускаются с `--no-builtin-tools` + worker-расширением: observer **без
  тулов** (чистый маппер), consolidator — **только scoped** `read/write/edit/ls/grep`
  в пределах `.memory/<session>/` (path containment, без bash/сети).
- `estimateTokens` — эвристика (chars/4 + densification), достаточно точная для
  порогов (±10–20%).

## Лицензия

MIT.
