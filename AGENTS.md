# AGENTS.md — Observational Memory (agent-agnostic core + pi adapter)

Справочник для ИИ-агентов, работающих в этом репозитории.

## Проект в одном абзаце

Observational Memory (OM) — система долгой памяти для LLM-агентов: фоновые
«observers» дистиллируют сырую историю диалога в атомарные **наблюдения**,
которые детерминированно рендерятся в **блок компакции** (заменяя старую историю),
а «consolidator» склеивает старейшие наблюдения в долговременные тематические
файлы. Ядро не завязано на агента; первый адаптер — для **pi-coding-agent**
(pi extension + headless subprocess-воркеры).

- Контекст/решения: `PROJECT_MEMORY.md` (обязательно читать в начале сессии)
- Этапы/задачи: `roadmap.md` (обязательно обновлять после коммитов)

## Ключевые документы

| Файл | Назначение |
|------|-----------|
| `PROJECT_MEMORY.md` | Контекст проекта, архитектура, открытые вопросы, процесс |
| `roadmap.md` | Все этапы и задачи, статус выполнения, журнал коммитов |
| `docs/REQUIREMENTS.md` | Требования (создать в Discovery) |
| `docs/ARCHITECTURE.md` | Архитектура и интерфейсы (создать в Design) |
| `README.md` | Установка/использование (создать перед релизом) |

## Референсы (читать, НЕ копировать)

- https://github.com/amosblomqvist/pi-observational-memory — архитектура-референс
  (лицензия: проверять перед копированием кода; предпочитается написание с нуля)
- https://mastra.ai/docs/memory/observational-memory — концепция (Observer/Reflector,
  extractors, temporal markers)
- pi docs (локально): `/home/arkalaust/.pi/agent/install/releases/0.86.1/node_modules/@earendil-works/pi-coding-agent/docs/`
  — `extensions.md` (API адаптера), `sessions.md` (формат сессий), `settings.md`, `compaction.md`

## Технологии

- TypeScript (ESM, strict), Node.js 20+
- Тесты: vitest (`npm test`), типизация: `tsc --noEmit` (`npm run typecheck`)
- Пакет: единый npm-пакет, subpath exports `./core`, `./adapters/pi` (итог — см. Design)

## Правила работы (обязательно)

1. Перед каждым шагом — составить todo-план на русском и показать пользователю.
2. В todo ОБЯЗАТЕЛЬНО пункты: «Компиляция и тестирование»,
   «Получить разрешение от пользователя на коммит».
3. Каждое действие сопровождать кратким описанием на русском.
4. После шага — отчёт: цель / что сделано / критерий завершения.
5. **Коммит только после явного одобрения пользователем.** После коммита —
   отметить пункты в `roadmap.md` и добавить строку в «Журнал коммитов».
6. Обновлять `PROJECT_MEMORY.md` при новых решениях/решённых вопросах.
7. Не уверен — задать вопрос пользователю, а не додумывать.

## Структура (целевая, см. PROJECT_MEMORY.md §5)

```
core/          # agent-agnostic ядро: types, config, tokens, chunker, ledger,
               # orchestrator, memory-store, prompts, cost, runner-интерфейс
adapters/pi/   # pi extension: события → оркестратор, subprocess runner, /om* команды
tests/         # vitest
docs/          # REQUIREMENTS.md, ARCHITECTURE.md
```

## Определения (глоссарий)

- **Observation** — атомарная заметка `{id/timestamp, content, tokenCount}`.
- **Chunk** — фиксированный token-bounded слайс новой истории для observer'а.
- **Ledger** — append-only пул наблюдений (branch-local в pi).
- **Compaction block** — детерминированный (model-free) рендер пула + memory map
  + journey, вставляемый при компакции вместо сырой истории.
- **Consolidator** — последовательный воркер, склеивающий старейшие наблюдения
  в `<root>/<sessionId>/<topic>.md` (+ INDEX.md, JOURNEY.md).
- **Watermark (coversUpToId)** — прогресс обработки истории; observers
  завершаются в любом порядке.
- **Passive mode** — отключены все триггеры (только ручные команды), для теста /tree.

## Чеклист качества

- `npm run typecheck` — без ошибок
- `npm test` — зелёный
- Нет привязки ядра к pi: `core/` не импортирует `adapters/*`
- Все LLM-вызовы — только через интерфейс `ModelRunner` (заменяемо в тестах)
