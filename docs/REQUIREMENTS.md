# REQUIREMENTS — Observational Memory (`@stelmakhdigital/observational-memory`)

Версия 1.0 · Дата: 2025-09 · Статус: принято (фаза Discovery закрыта)

## 1. Назначение

Agent-agnostic библиотека Observational Memory (OM) для LLM-агентов: фоновое сжатие
сырой истории диалога в плотные атомарные **наблюдения**, которые детерминированно
рендерятся в **блок компакции** (заменяя старую историю в контексте), а старейшие
наблюдения склеиваются в **долговременные тематические файлы**. Первый и основной
адаптер — расширение для **pi-coding-agent** (pi ≥ 0.86.1).

Цели (из PMBOK charter, см. PROJECT_MEMORY.md §1, §2):
- борьба с context rot / context waste в длинных сессиях;
- стабильный кэшируемый префикс промпта (prompt caching → экономия токенов);
- долговременная память, переживающая сессию;
- прозрачность: фоновые LLM-вызовы аудитабельны, стоимость видна пользователю.

## 2. Актёры

| Актёр | Ожидание |
|-------|----------|
| Пользователь (человек) | Включил — работает; виден статус/стоимость; можно форсировать compact/consolidate; off = полное отсутствие влияния |
| Агент (пи-сессия «master») | На компакции видит блок OM вместо сырой истории + карту памяти + journey; качество на длинных сессиях не падает |
| Observer-воркер | Получает слайс истории → возвращает атомарные наблюдения |
| Consolidator-воркер | Получает старейшие наблюдения → пишет тематические файлы |
| Разработчик/интегратор | Подключает ядро к своему агенту через интерфейсы без vendor lock-in |

## 3. Функциональные требования (v1)

### FR-1. Observers
- FR-1.1 При накоплении ≥ `chunkTokens` новых токенов истории режется фиксированный
  token-bounded слайс (chunk) и запускается observer-воркер.
- FR-1.2 Observers выполняются **параллельно** (чистые мапперы), concurrency ограничен
  `observerConcurrency` (default 4).
- FR-1.3 Каждый observer коммитит наблюдения со своим watermark `coversUpToId`;
  завершение в любом порядке корректно (нет глобальной блокировки).
- FR-1.4 Наблюдение: `{ id/timestamp, content, tokenCount }`.
- FR-1.5 Наблюдения — атомарные, самодостаточные заметки «что произошло»
  (решения, факты, сделанная работа), без дублирования соседних чанков
  (overlapping-контекст передаётся observer'у для связности).

### FR-2. Ledger (буфер наблюдений)
- FR-2.1 Append-only пул наблюдений; в pi хранится через `pi.appendEntry`
  (branch-local, переживает resume, корректен при `/tree`).
- FR-2.2 Детерминированный **model-free** рендер пула в compaction block
  (одинаковый ввод → одинаковый вывод; без LLM).
- FR-2.3 Tombstones: consolidator-отчётные наблюдения вымаркиваются и не рендерятся.

### FR-3. Compaction
- FR-3.1 Триггер: context usage ≥ `compactAtContextTokens` и агент idle.
- FR-3.2 Перед рендером ожидание in-flight observers (не потерять новые наблюдения).
- FR-3.3 Compaction block = буфер наблюдений + **memory map** (front-matter тематических
  файлов, рендерится live) + **journey** (JOURNEY.md, verbatim).
- FR-3.4 Verbatim-хвост (`tailTokens`) снапится на границу чанка наблюдений — хвост
  не дублируется наблюдениями.
- FR-3.5 Команда ручного форсажа: `/om:compact` (игнорирует порог).

### FR-4. Consolidator
- FR-4.1 Триггер: пул > `consolidateAtPoolTokens` (по умолч. 200% от `poolTargetTokens`);
  выполняется **последовательно** (один за раз).
- FR-4.2 Склеиваются **старейшие** наблюдения (выше `poolTargetTokens`) в долгие файлы
  `<memoryRoot>/<sessionId>/<topic>.md` (markdown, front-matter: тема, описание, session).
- FR-4.3 После отчёта воркера оркестратор tombstone'ит именно те наблюдения → пул
  возвращается к целевому размеру.
- FR-4.4 Тематические файлы **per-session** (immutable session id), не откатываются при
  `/tree`; на fork/clone память seed'ится от родителя **один раз**.
- FR-4.5 `INDEX.md` владению оркестратора (перерисовка из front-matter после каждого прогона).
- FR-4.6 Команда ручного форсажа: `/om:consolidate`.

### FR-5. Journey
- FR-5.1 `JOURNEY.md` — единое описательное (не императивное) прозаическое описание
  того, как работа дошла до текущего состояния; ведётся consolidator'ом.
- FR-5.2 Append-mostly: каждый consolidation добавляет короткий датированный сегмент;
  старейшие сегменты сжимаются при превышении `journeyTargetTokens`.
- FR-5.3 Вставляется в каждый compaction block для ориентации (не recall, не инструкции).
- FR-5.4 Не откатывается при `/tree`.

### FR-6. Cost tracking
- FR-6.1 Стоимость каждого воркера (из usage воркера) аккумулируется в ledger
  (`om.cost` entries) по всем веткам — сумма никогда не уменьшается при `/tree`.
- FR-6.2 Отображается в статусе UI и в `/om:status`: `session cost: $X (N runs)`.
- FR-6.3 Переживает resume.

### FR-7. Управление и UI (pi adapter)
- FR-7.1 Команды: `/om` (toggle), `/om on|off`, `/om:status`, `/om:compact`, `/om:consolidate`.
- FR-7.2 Пер-сессия on/off gate по умолчанию **OFF**, состояние в ledger, переживает resume.
  Когда off — все триггеры/хуки/UI/процессы неактивны (полная невидимость).
- FR-7.3 `/om:status`: в-flight воркеры, число активных наблюдений, прогресс до
  следующего observer, состояние пула/консолидатора, число тематических файлов,
  размер journey, usage контекста, стоимость сессии, последняя ошибка.
- FR-7.4 `passive` mode (power-user): отключены все автотриггеры, работают ручные команды
  (для тестирования `/tree`).

### FR-8. Gap markers (v1, из Mastra)
- FR-8.1 При возобновлении сессии/обращения после паузы ≥ `gapThresholdMs`
  (default 10 минут) в историю вставляется краткая метка «прошло X с последнего
  сообщения» (временной якорь).
- FR-8.2 Метка видна observer'у (якорит наблюдения во времени) и учитывается при
  оценке токенов; детерминированно (без LLM).
- FR-8.3 Настраивается (`gapThresholdMs`, `enabled`), по умолчанию включено в v1.

### FR-9. Конфигурация
- FR-9.1 Неймспейс `observational-memory` в `~/.pi/agent/settings.json` (global)
  и `.pi/settings.json` (project, переопределяет global).
- FR-9.2 Параметры v1 (дефолты — значения референса): `chunkTokens: 5000`,
  `chunkOverlapTokens: 0`, `poolTargetTokens: 10000`, `consolidateAtPoolTokens: 20000`,
  `compactAtContextTokens: 100000`, `tailTokens: 20000`, `journeyTargetTokens: 1000`,
  `observerConcurrency: 4`, `models.observer`, `models.consolidator`, `passive`,
  `debugLog`, `gapMarkers: {enabled, thresholdMs}`, `piBinary`.
- FR-9.3 Инварианты валидации: `consolidateAtPoolTokens > poolTargetTokens`,
  `chunkTokens > 0`, `tailTokens > 0`; нарушение → понятная ошибка, расширение
  не грузится молча.

### FR-10. Ядро без привязки к агенту
- FR-10.1 `core/` не импортирует `adapters/*`; агент-специфичное — только через
  интерфейсы: `ModelRunner`, `HistorySource`, `LedgerStore`, `EventSink`, `MemoryRoot`.
- FR-10.2 Все LLM-вызовы — только через `ModelRunner.run(role, input)` → заменяемо
  mock'ом в тестах.
- FR-10.3 Публичный API: `./core` (оркестратор + интерфейсы), `./adapters/pi`
  (готовый entry расширения pi).

## 4. Нефункциональные требования

- **NFR-1 Надёжность:** сбой воркера не ломает master-сессию (ошибка логируется,
  видна в `/om:status`, ретраит ограничен); ledger не повреждается (append-only,
  атомарные записи).
- **NFR-2 Детерминизм:** рендер compaction block и gap markers — model-free и
  детерминированные (тестируемо без LLM).
- **NFR-3 Наблюдаемость:** debug log (опц.), все воркеры — записанные сессии pi
  (auditable в session browser).
- **NFR-4 Стоимость:** фоновые вызовы учитываются и видимы (FR-6); observer — дешёвая
  модель/низкий thinking, consolidator — по конфигурации.
- **NFR-5 Производительность:** master не блокируется воркерами (все LLM-работы —
  в subprocess); token estimation — быстрая, без LLM.
- **NFR-6 Конфиденциальность:** память живёт в пределах проекта (`.memory/`), ничего
  не уходит наружу, кроме вызовов LLM-провайдера, заданных пользователем.
- **NFR-7 Тестируемость:** unit-тесты core без LLM (mock ModelRunner), интеграционные
  тесты пайплайна, smoke адаптера.
- **NFR-8 Совместимость:** Node 20+, ESM, TS strict, pi ≥ 0.86.1.

## 5. Scope v2 (не в v1, задел интерфейсов)

- Extractors (Mastra-style): извлечение структурированных значений (профиль юзера и т.п.)
  через extension point ядра (интерфейс `ExtractorHook`).
- Early activation: активация буфера до порога при idle/смене провайдера
  (extension point `ActivationPolicy`).
- Дополнительные адаптеры (не-pi).

## 6. Ограничения и предпосылки

- pi ≥ 0.86.1; бинарник `pi` доступен в PATH (или `piBinary` в конфиге).
- LLM-доступ (провайдеры) настраивается пользователем в самом pi.
- Язык: TypeScript; пакет: единый npm, exports `./core`, `./adapters/pi`.

## 7. Риски (PMBOK: Identify Risks)

| # | Риск | Влияние | Митигация |
|---|------|---------|-----------|
| R1 | Поведение `pi.appendEntry`/веток отличается от ожиданий | Корректность ledger при `/tree` | Ранний spike в Design; фолбэк — внешний ledger-файл (интерфейс `LedgerStore`) |
| R2 | Subprocess `pi` недоступен/сломан | OM не работает | Проверка при запуске, понятная ошибка; `debugLog`; passive mode |
| R3 | Наблюдения дублируют/теряют информацию | Качество памяти | Overlap-контекст для observer'а; watermarks; тесты рендера |
| R4 | Рост стоимости фоновых вызовов | Деньги пользователя | Cost tracking + пороговые дефолты; observer — дешёвая модель |
| R5 | Конфликт с встроенной компакцией pi | Двойная/битая компакция | Триггер на `agent_end`+idle, ожидание observers; smoke-тесты |

## 8. Критерии приёмки v1

1. `npm run typecheck` и `npm test` — зелёные (unit + интеграция, без LLM).
2. В pi: `/om on` → после накопления `chunkTokens` создаются наблюдения
   (видны в ledger/`/om:status`).
3. При контексте ≥ `compactAtContextTokens` компакция использует OM-блок
   (наблюдения + memory map + journey), verbatim-хвост не дублируется.
4. При пуле > `consolidateAtPoolTokens` consolidator создаёт тематические файлы,
   пул возвращается к цели, tombstones работают.
5. Пауза ≥ порога → в истории появляется gap-marker.
6. Стоимость сессии отображается и не уменьшается при `/tree`.
7. `/om off` — полная невидимость (нет процессов, UI, триггеров).
