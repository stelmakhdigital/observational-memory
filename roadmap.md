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
- [ ] Ядро: orchestrator (observer clock, consolidator clock, compaction, concurrency, idle-wait)
- [ ] Ядро: memory-store (topic files, INDEX.md, JOURNEY.md, fork-seed)
- [ ] Ядро: gap-markers (v1: генерация меток временных пауз, якоря для observer'а)
- [ ] Ядро: prompts (observer / consolidator) + cost accounting
- [ ] Adapter pi: входные события → оркестратор; ledger через pi.appendEntry
- [ ] Adapter pi: ModelRunner через headless subprocess pi
- [ ] Adapter pi: команды /om*, status UI, конфиг settings.json

## 4. Реализация (Implementation)
- [x] Core: config + types + tokens + chunker (+ unit-тесты)
- [x] Core: ledger (+ unit-тесты)
- [ ] Core: orchestrator (+ unit-тесты с mock-ModelRunner)
- [ ] Core: memory-store (+ unit-тесты)
- [ ] Core: gap-markers (+ unit-тесты)
- [ ] Core: prompts + cost (+ тесты)
- [ ] Adapter pi: events/session/runner/commands/ui
- [ ] Интеграционные тесты пайплайна (mock runner)
- [ ] README.md + docs (installation, configuration, usage)

## 5. Тестирование (Verification / Testing)
- [ ] npm run typecheck — чисто
- [ ] npm test — все тесты зелёные
- [ ] Smoke: установка в pi, /om on, сессия → observations создаются, /om:status, компакция

## 6. Релиз (PMBOK: Closing + Release)
- [ ] Финальный обзор кода, чистка
- [ ] Тег v0.1.0 (по согласованию)

## 7. Эксплуатация / Обратная связь (Post-project)
- [ ] Сбор обратной связи от использования в pi
- [ ] v2: extractors (Mastra-style), early activation, другие адаптеры

## Журнал коммитов
| Дата | Commit | Содержание |
|------|--------|-----------|
| 2025-09 | 594b50e | Discovery: чартер проекта, сбор требований, решения (PROJECT_MEMORY.md, roadmap.md, AGENTS.md, .gitignore) |
| 2025-09 | d3256cf | Discovery: спецификация требований (docs/REQUIREMENTS.md) — фаза закрыта |
| 2025-09 | d225aee | Planning: архитектура (docs/ARCHITECTURE.md) |
| 2025-09 | a4593cb | Sprint 1: skeleton пакета + core types/config/ids + unit-тесты (12 passed) |
| 2025-09 | ca5532e | Sprint 2: tokens + chunker + unit-тесты (26 passed) |
| 2025-09 | —       | Sprint 3: ledger (pool/progress/render/serialize) + unit-тесты (45 passed) |
