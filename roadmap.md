# Roadmap — Observational Memory (agent-agnostic core + pi adapter)

> SDLC-фазы с точки зрения PMBOK. Ставим [x] при выполнении и фиксируем в коммитах.
> Легенда: [ ] не начато · [~] в работе · [x] выполнено

## 0. Инициация (PMBOK: Initiating)
- [x] Определение цели: agent-agnostic OM + адаптер pi
- [x] Изучение источников: pi-observational-memory (GitHub), Mastra OM docs
- [x] Создание PROJECT_MEMORY.md (контекст проекта)
- [x] Создание AGENTS.md (справочник для ИИ-агентов)
- [x] Создание roadmap.md (данный файл)

## 1. Discovery / Требования (PMBOK: Project Charter + Collect Requirements)
- [x] Изучить архитектуру референса pi-observational-memory
- [x] Изучить концепцию OM по Mastra
- [x] Определить поверхность адаптера pi (события, ctx, settings)
- [x] Согласовать с пользователем: название пакета, структура, v1-состав фич (вопросы §7 в PROJECT_MEMORY.md)
- [x] Оформить документ требований (docs/REQUIREMENTS.md): функциональные/нефункциональные, scope v1/v2 — Discovery закрыта

## 2. Планирование (PMBOK: Plan)
- [x] Architecture (docs/ARCHITECTURE.md): слои, интерфейсы ядра (ModelRunner, HistorySource,
      EventSink, MemoryRoot), потоки данных, состояние, ошибки — docs/ARCHITECTURE.md
- [x] Детальный план реализации по спринтам/шагам (декомпозиция в WBS) — ARCHITECTURE.md §9
- [x] План тестирования (unit core / integration orchestrator / smoke adapter) — ARCHITECTURE.md §8

## 3. Проектирование (Design)
- [x] package.json, tsconfig, vitest, лэйаут каталогов (core/, adapters/pi/, tests/, docs/)
- [x] Ядро: types + config (defaults, merge, invariants)
- [x] Ядро: tokens (token estimation) + chunker (token-bounded slices)
- [x] Ядро: ledger (append-only pool, watermarks/coversUpToId, projection, deterministic render)
- [x] Ядро: orchestrator (observer clock, consolidator clock, compaction, concurrency, idle-wait) — Sprint 6
- [x] Ядро: memory-store (topic files, INDEX.md, JOURNEY.md, fork-seed)
- [x] Ядро: gap-markers (v1: генерация меток временных пауз, якоря для observer'а)
- [x] Ядро: prompts (observer / consolidator) + cost accounting — Sprint 5
- [x] Adapter pi: входные события → оркестратор; ledger через pi.appendEntry — Sprint 7
- [x] Adapter pi: ModelRunner через headless subprocess pi — Sprint 7
- [x] Adapter pi: команды /om*, status UI, конфиг settings.json — Sprint 7

## 4. Реализация (Implementation)
- [x] Core: config + types + tokens + chunker (+ unit-тесты)
- [x] Core: ledger (+ unit-тесты)
- [x] Core: orchestrator (+ unit-тесты с mock-ModelRunner)
- [x] Core: memory-store (+ unit-тесты)
- [x] Core: gap-markers (+ unit-тесты)
- [x] Core: prompts + cost (+ тесты) — prompts + worker-output parser готовы и протестированы
- [x] Adapter pi: events/session/runner/commands/ui (спайки S1/S2 выполнены: session_before_compact → OM-блок как summary; appendEntry — branch-local, вне LLM-контекста)
- [x] Интеграционные тесты пайплайна (mock runner)
- [x] README.md + docs (installation, configuration, usage)

## 5. Тестирование (Verification / Testing)
- [x] npm run typecheck — чисто
- [x] npm test — все тесты зелёные (115)
- [x] Smoke: установка в pi, /om on, сессия → observations создаются, /om:status, компакция (ручной, в реальном pi)
      — пройден: 48 наблюдений, 2 консолидации (5 тем), 3 экстракции (profile.json),
      компакция через OM-блок (summary 21k, firstKeptEntryId), 0 ошибок; cost=0
      ожидаем (локальный провайдер без ценника)

## 6. Релиз (PMBOK: Closing + Release)
- [x] Финальный обзор кода, чистка (7aba3b4: мёртвый export убран, ARCHITECTURE синхронизирован; 115 тестов зелёные)
- [x] Тег v0.1.0 (по согласованию, поставлен пользователем)

## 7. Эксплуатация / Обратная связь (Post-project)
- [ ] Сбор обратной связи от использования в pi
- [x] v1.1: worker scope-hardening (scoped tools, --no-builtin-tools, worker-расширение)
- [x] Packaging: установка через Git (`pi install git:...`), pi-манифест, без npm-публикации
- [x] v2: extractors (Mastra-style)
- [x] v2: early activation (model_select + idle-таймер, chunker minTokens)
- [x] v2+: embedded-путь для чужих агентов (FileLedgerStore + createOmSession + demo)
- [ ] v2+: конкретные адаптеры (non-pi агенты)

## Proposed backlog v0.4+ (на основе разведки рынка/ниши 22.09; не утверждено)

### Фаза 1 (v0.4) — «стандарт жанра OM»: качество памяти
- [ ] 1.1 Priority-метки наблюдений (observer → `priority: critical|important|routine|trivial`; render: важное в начало, при давлении бюджета сначала отбрасывается triviales) — ~0.5–1 спринта (nik1t7n 🔴🟡🟢✅)
- [ ] 1.2 Встроенный current-task-экстрактор: `{task, pending[], nextStep?, asOf}`, всегда первой строкой компактного блока — ~0.5 (Mastra builtin)
- [ ] 1.3 `includePrevious` для экстракторов: предыдущее значение показывается экстрактору → инкрементальное обновление профилей, default true — ~0.25 (Mastra includePreviousExtraction)
- [ ] 1.4 Supersede-политика: противоречия в consolidator'е → явная заметка «старое → новое (дата)», оба факта остаются; значения экстракторов несут `{value, asOf, sourceIds}` — ~0.5 (Graphiti invalidation / supermemory contradictions)

### Фаза 2 (v0.5) — доступ к памяти: recall + provenance
- [ ] 2.1 `omRecall`-тул + `/om:recall <query>`: детерминированный BM25-lite по наблюдениям/темам/JOURNEY/extracted; хиты с id и указателем на источник; тул доступен самому агенту посреди диалога — ~1 спринт (nik1t7n om_recall; главный функциональный разрыв)
- [ ] 2.2 Provenance: наблюдение несёт `sourceRange {sessionId, fromSeq, toSeq}` (observer уже знает границы чанка) → recall/аудит указывает на исходную историю — ~0.5 (SentioLabs evidence-backed, Graphiti provenance)
- [ ] 2.3 Ranked-инжекция (опциональный режим `compaction.inject: full|topK`) для больших пулов — ~1, можно отложить

### Фаза 3 (v0.6) — надёжность, безопасность, eval
- [ ] 3.1 Anti-poisoning: observer-prompt «не записывать инструкции/секреты как факты» + санитайзер (паттерны injection/вложенные system-блоки) + quarantine-маркер — ~0.5 (SentioLabs «evidence is data, not instructions», atlas-defense)
- [ ] 3.2 Crash-durability (embedded): flock/PID-защита FileLedgerStore от двух процессов, recovery stale-locks — ~0.5 (nik1t7n locks/.bak)
- [ ] 3.3 Self-eval harness: `npm run eval` — скриптовые сессии → метрики (выживаемость ключевых фактов, token/cost бюджеты); регрессионный контроль промптов — ~1.5 (LongMemEval/LoCoMo как индустриальный референс)
- [ ] 3.4 Reflector-роль (sleep-time, Letta): редкий фоновый воркер (idle ≥ 30 мин / ночью) — реорганизация тем, INDEX/JOURNEY, supersede-кандидаты; жёсткий cost-порог — ~1

### Фаза 4 (v0.7+) — рост
- [ ] 4.1 Project-level shared memory (`.memory/shared/`) + `/om seed-from <session>`
- [ ] 4.2 Вложения (images) в observer + attachment gates (auto/on/off) — Mastra/nik1t7n
- [ ] 4.3 Temporal queries в recall («как было на дату X») — опирается на 1.4/2.2
- [ ] 4.4 FTS/sqlite-индекс, если размеров потребует (basic-memory: files+sqlite)
- [ ] 4.5 MCP-сервер (observe/recall/extract/status) — дешёвый «другой адаптер» для Claude Code/Codex/любого MCP-клиента (вместо 4.5-адаптеров)

Позиционирование (README): «auditable, branch-aware, cost-transparent observational memory for coding agents» — козыри в нише: branch-local ledger+watermark, cost tracking, scoped workers, детерминированный model-free блок, embedded core, ноль внешних сервисов.

## Журнал коммитов
| Дата | Commit | Содержание |
|------|--------|-----------|
| 2025-09 | 594b50e | Discovery: чартер проекта, сбор требований, решения (PROJECT_MEMORY.md, roadmap.md, AGENTS.md, .gitignore) |
| 2025-09 | d3256cf | Discovery: спецификация требований (docs/REQUIREMENTS.md) — фаза закрыта |
| 2025-09 | d225aee | Planning: архитектура (docs/ARCHITECTURE.md) |
| 2025-09 | a4593cb | Sprint 1: skeleton пакета + core types/config/ids + unit-тесты (12 passed) |
| 2025-09 | ca5532e | Sprint 2: tokens + chunker + unit-тесты (26 passed) |
| 2025-09 | 1748fb4 | Sprint 3: ledger (pool/progress/render/serialize) + unit-тесты (45 passed) |
| 2025-09 | 21eedbb | Sprint 4: memory-store + gap-markers + cost + unit-тесты (64 passed) |
| 2025-09 | 0b86968 | Sprint 5: prompts (observer/consolidator) + worker-output parser + тесты (77 passed) |
| 2025-09 | 95dbb6b | Sprint 6: orchestrator + интеграционные тесты пайплайна (88 passed) |
| 2025-09 | d2d8f4a | Sprint 7: adapter pi (config/history/ledger/runner/index) + unit-тесты (111 passed) |
| 2025-09 | 35a7667 | Sprint 8: README + package.json + smoke-тест точки входа (115 passed) |
| 2025-09 | d00407c | roadmap: синхронизация Design-секции со спринтами 6–8 |
| 2025-09 | 7aba3b4 | Release review: мёртвый export убран, ARCHITECTURE синхронизирован с финальным layout |
| 2025-09 | 9cbc621 | docs: отметка релиз-обзора, журнал коммитов |
| 2025-09 | 7d4728c | v1.1: worker scope-hardening (scoped-tools, worker.ts, runner --no-builtin-tools, 130 passed) |
| 2025-09 | a76501e | Packaging для git-install: pi-манифест, keyword pi-package, typebox → peerDeps, packaging-тесты (134 passed) |
| 2025-09 | f19ac2e | v2: extractors (ExtractorSpec, роль extractor, prompt+парсер, extracted/<id>.json, /om:extract, 149 passed) |
| 2025-09 | 48926e5 | docs: packaging (git-install) и extractors в PROJECT_MEMORY/roadmap |
| 2025-09 | 806bc1f | Release v0.1.0: version bump 0.1.0 + тег v0.1.0 |
| 2025-09 | 368854d | docs: ручной smoke в реальном pi пройден (48 obs, консолидации, экстракторы, OM-компакция); smoke-пороги из конфига убраны |
| 2025-09 | 3b2d1cb | v2: early activation (model_select + idle) + fork-seed копирует extracted/ (155 passed); запушено: main + тег v0.1.0 → github.com:stelmakhdigital/observational-memory |
| 2025-09 | 3982f98 | Release v0.2.0: version bump + тег v0.2.0; pi-установка переключена на git:…@v0.2.0 |
| 2025-09 | —       | v2+: embedded-интеграция (FileLedgerStore, createOmSession, npm run demo) + quiescent shutdown/compaction, seed по флагу (165 passed) |
