# Company Second Brain -- Project Specification

> **Version**: 1.0 (2026-03-24)
> **Authors**: PM + Tech Lead 공동 작성
> **Status**: Draft

---

## 1. 시스템 개요

### 1.1 전체 비전

**회사의 모든 업무 컨텍스트(대화, 문서, 결정, 회의)를 자동으로 수집/구조화하여, AI Agent가 "회사의 기억"을 기반으로 업무를 지원하는 시스템.**

### 1.2 아키텍처 다이어그램

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Layer 3: Agent Layer (별도 프로젝트)                │
│                                                                     │
│   ┌───────────────┐  ┌──────────────────┐  ┌───────────────────┐   │
│   │ Meeting Agent  │  │ Memory Steward   │  │ Workflow Advisor  │   │
│   │ (회의 요약/반영) │  │ (기억 품질 관리)    │  │ (패턴 분석/제안)    │   │
│   └───────┬───────┘  └────────┬─────────┘  └────────┬──────────┘   │
│           │                   │                      │              │
└───────────┼───────────────────┼──────────────────────┼──────────────┘
            │                   │                      │
            └───────────────────┼──────────────────────┘
                                │ MCP Client
┌───────────────────────────────┼─────────────────────────────────────┐
│              Layer 2: Context Engine (신규 프로젝트)                   │
│                               │                                     │
│   ┌───────────────────────────▼────────────────────────────────┐   │
│   │                  EnrichmentProvider                         │   │
│   │    CORTEX_ENRICHMENT=rule|llm|off                          │   │
│   └──────┬──────────┬──────────┬──────────┬───────────────────┘   │
│          │          │          │          │                        │
│   ┌──────▼──┐ ┌─────▼────┐ ┌──▼──────┐ ┌▼────────────┐          │
│   │Decision │ │Action    │ │Topic    │ │Entity       │          │
│   │Extrac-  │ │Item      │ │Thread   │ │Resolution   │          │
│   │tion     │ │Extraction│ │Stitching│ │(cross-src)  │          │
│   └─────────┘ └──────────┘ └─────────┘ └─────────────┘          │
│                                                                   │
└───────────────────────────────┬───────────────────────────────────┘
                                │ MCP Tools (24개)
┌───────────────────────────────┼───────────────────────────────────┐
│             Layer 1: Memory System (Hive-Memory v3)                │
│                               │                                    │
│   ┌───────────────────────────▼──────────────────────────────┐    │
│   │              CortexStore + HiveDatabase                   │    │
│   │                  SQLite + FTS5 + WAL                      │    │
│   └────┬──────────┬──────────┬──────────┬────────────────────┘    │
│        │          │          │          │                          │
│   ┌────▼────┐ ┌───▼───┐ ┌───▼───┐ ┌───▼────┐                    │
│   │Entities │ │Synapse│ │Spread │ │Hebbian │                    │
│   │12 types │ │Graph  │ │Activ- │ │Learning│                    │
│   │FTS5 BM25│ │14 axon│ │ation  │ │LTP/LTD │                    │
│   └────┬────┘ └───────┘ └───────┘ └────────┘                    │
│        │                                                          │
│   ┌────▼────────────────────────────────────────────────────┐    │
│   │              Connectors                                  │    │
│   │  GitHub | Slack | Notion | Calendar (미구현)              │    │
│   └──────────────────────────────────────────────────────────┘    │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### 1.3 레이어 분리 원칙

| 원칙 | 설명 |
|------|------|
| **NO LLM in Layer 1** | Memory System은 LLM 없이 동작. 모든 추론은 Layer 2에서 수행 |
| **MCP 경계** | Layer 2는 Layer 1을 MCP client로만 접근. 직접 SQLite 접근 금지 |
| **별도 배포** | 각 레이어는 독립적으로 배포/업데이트 가능 |
| **Fail-safe** | Layer 2가 꺼져도 Layer 1은 정상 동작. Layer 3이 꺼져도 Layer 1+2는 정상 동작 |
| **Cost control** | LLM 비용이 발생하는 레이어(2, 3)는 환경변수로 on/off 제어 가능 |

---

## 2. Layer 1: Memory System (Hive-Memory)

### 2.1 책임 범위

- 외부 데이터 소스로부터 raw 데이터 수집 (Connector)
- Entity 기반 지식 저장 및 검색 (SQLite + FTS5)
- Synapse 기반 그래프 관계 관리 (14 axon types)
- Hebbian learning을 통한 자동 관계 강화/약화
- 팀 간 지식 공유 (Git-based team sync)
- AI Agent에게 24개 MCP tool 제공

### 2.2 현재 구현 상태

| 구성요소 | 상태 | 비고 |
|---------|------|------|
| SQLite + FTS5 + WAL | :white_check_mark: 완료 | `~/.cortex/cortex.db` |
| Entity model (12 types) | :white_check_mark: 완료 | entities table |
| Synapse graph (14 axon types) | :white_check_mark: 완료 | synapses table |
| Hebbian learning (LTP/LTD) | :white_check_mark: 완료 | coactivations table |
| Spreading activation | :white_check_mark: 완료 | beam search + graph traversal |
| FTS5 BM25 + RRF fusion | :white_check_mark: 완료 | keyword + graph 결합 검색 |
| 24 MCP tools | :white_check_mark: 완료 | 7개 카테고리 |
| GitHub connector | :white_check_mark: 완료 | PR, Issue, ADR, CODEOWNERS |
| Slack connector | :white_check_mark: 완료 | signal-filtered messages + threads |
| Notion connector | :white_check_mark: 완료 | pages, databases, block content |
| Calendar connector | :x: 미구현 | Google Calendar / Outlook 필요 |
| Git-based team sync | :white_check_mark: 완료 | per-entry JSON files |
| v2 -> v3 migration | :white_check_mark: 완료 | JSON -> SQLite auto-migration |
| SessionEnd hook | :white_check_mark: 완료 | JSONL transcript parsing |
| CLI commands | :white_check_mark: 완료 | store, recall, status, sync, team, hook, cleanup, stats |

### 2.3 남은 작업

| 작업 | 우선순위 | 예상 규모 | 비고 |
|------|---------|----------|------|
| Calendar connector (Google Calendar) | P1 | 1주 | OAuth2 flow 필요. ConnectorPlugin interface 준수 |
| Calendar connector (Outlook/Exchange) | P2 | 1주 | Microsoft Graph API |
| Entity deduplication | P1 | 2-3일 | source_external_id 기반 upsert 보강 |
| Connector error recovery | P2 | 2-3일 | 현재 에러 시 중단. partial sync resume 필요 |
| Batch synapse creation 성능 | P3 | 1일 | 대량 import 시 transaction batching 최적화 |

### 2.4 제공하는 인터페이스 (MCP Tools 24개)

#### Project (4 tools)

| Tool | 설명 | 주요 파라미터 |
|------|------|-------------|
| `project_register` | 프로젝트 등록/업데이트 (upsert) | name, path, description, tags |
| `project_search` | 이름/태그로 프로젝트 검색 (빈 query = 전체 목록) | query |
| `project_status` | 프로젝트 컨텍스트 로드 (brief/full) | project, detail |
| `project_onboard` | 디렉토리 스캔 -> 프로젝트 자동 발견 | path |

#### Memory (5 tools)

| Tool | 설명 | 주요 파라미터 |
|------|------|-------------|
| `memory_store` | 지식 저장. Auto-creates temporal + semantic synapses | project, category, content, tags |
| `memory_recall` | FTS5 BM25 + spreading activation + RRF fusion 검색 | query, project, limit |
| `memory_link` | 명시적 synapse 생성 | source, target, axon, metadata |
| `memory_traverse` | 그래프 순회 (depth 지정) | query, depth, decay, threshold |
| `memory_connections` | 특정 entity의 synapse 연결 조회 | id, direction |

#### Session (1 tool)

| Tool | 설명 | 주요 파라미터 |
|------|------|-------------|
| `session_save` | 세션 요약 저장 + .cortex.md 동기화 | project, summary, nextTasks, decisions, learnings |

#### Browse (5 tools)

| Tool | 설명 | 주요 파라미터 |
|------|------|-------------|
| `memory_ls` | 파일시스템 스타일 브라우징 (`/namespace/project/type`) | path, sort, limit, offset |
| `memory_tree` | 전체 구조 조회 (namespace -> project -> type) | path, depth |
| `memory_grep` | FTS5 full-text 검색 (AND, OR, NOT, quoted phrases) | pattern, scope, limit |
| `memory_inspect` | 단일 entity 상세 조회 (content + metadata + synapses) | id, depth |
| `memory_timeline` | 시간순 조회 (일별 그룹핑, 타입 아이콘) | scope, types, limit |

#### Trail (3 tools)

| Tool | 설명 | 주요 파라미터 |
|------|------|-------------|
| `memory_trail` | Cross-domain 타임라인 (topic 기반) | topic, domains, limit |
| `memory_who` | 특정 topic 전문가 찾기 (author별 rank) | topic, limit |
| `memory_decay` | 기억 소멸 + synapse LTD 실행 (dry_run 가능) | dry_run |

#### Connector (2 tools)

| Tool | 설명 | 주요 파라미터 |
|------|------|-------------|
| `connector_sync` | 특정 connector sync 실행 | connector, full |
| `connector_status` | 모든 connector 상태 조회 | - |

#### Team (4 tools)

| Tool | 설명 | 주요 파라미터 |
|------|------|-------------|
| `team_init` | 팀 cortex git repository 초기화 | path, remote |
| `team_push` | team-visibility entries를 git repo에 push | entries |
| `team_pull` | git repo에서 local DB로 pull | - |
| `team_status` | local DB <-> team cortex 동기화 상태 조회 | - |

### 2.5 데이터 모델

#### Entity Types (12)

```
Phase 1 (구현 완료): memory, reference, decision
Phase 2 (구현 완료): person, document
Phase 3 (구현 완료): conversation, message, meeting, task, event, snippet
```

#### Entity Schema

```sql
entities (
  id                TEXT PRIMARY KEY,
  entity_type       TEXT NOT NULL DEFAULT 'memory',   -- 12 types
  project           TEXT,
  namespace         TEXT NOT NULL DEFAULT 'local',    -- 'local' | 'team:{id}' | 'org:{id}'
  title             TEXT,
  content           TEXT NOT NULL,
  tags              TEXT NOT NULL DEFAULT '[]',       -- JSON array
  keywords          TEXT NOT NULL DEFAULT '[]',       -- JSON array
  attributes        TEXT NOT NULL DEFAULT '{}',       -- JSON object (flexible)
  source_system     TEXT NOT NULL DEFAULT 'agent',
  source_external_id TEXT,                            -- deduplication key
  source_url        TEXT,
  source_connector  TEXT,
  author            TEXT,
  visibility        TEXT NOT NULL DEFAULT 'personal', -- 'personal' | 'team'
  domain            TEXT NOT NULL DEFAULT 'code',     -- 7 domains
  confidence        TEXT NOT NULL DEFAULT 'confirmed',-- 'confirmed' | 'inferred'
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  expires_at        TEXT,
  status            TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'superseded' | 'archived'
  superseded_by     TEXT
)
```

#### Domain Types (7)

```
code | documents | conversations | meetings | incidents | product | operations
```

#### Axon Types (14)

```
v2 (7): temporal, causal, semantic, refinement, conflict, dependency, derived
v3 (7): authored, attended, mentioned, contains, supersedes, implements, belongs_to
```

#### Synapse Schema

```sql
synapses (
  id                TEXT PRIMARY KEY,
  source            TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target            TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  axon              TEXT NOT NULL,        -- 14 axon types
  weight            REAL NOT NULL DEFAULT 0.3,  -- 0.0 ~ 1.0
  metadata          TEXT DEFAULT '{}',
  formed_at         TEXT NOT NULL,
  last_potentiated  TEXT NOT NULL,
  UNIQUE(source, target, axon)
)
```

#### Hebbian Learning

```sql
coactivations (
  pair_key  TEXT PRIMARY KEY,  -- "entityA:entityB" (sorted)
  count     INTEGER NOT NULL DEFAULT 1
)
```

- **LTP**: co-activation 시 synapse weight +0.1
- **LTD**: 매 flush cycle마다 weight x0.995 decay
- **Pruning**: weight < 0.05 인 synapse 자동 제거
- **Auto-formation**: co-activation 5회 이상 시 Hebbian synapse 자동 생성

#### 기타 테이블

```sql
projects (id, name, path, description, tags, last_active, status, one_liner, tech_stack, modules, current_focus, last_session, stats)
sessions (id, project, date, summary, next_tasks, decisions, learnings, created_at)
connectors (id, connector_type, config, last_sync, status, sync_cursor)
```

#### FTS5 Virtual Table

```sql
entities_fts USING fts5(title, content, tags, content=entities, content_rowid=rowid)
-- INSERT/UPDATE/DELETE triggers로 자동 동기화
```

#### Indexes (14)

```
entities: project, entity_type, domain, namespace, status, created_at, updated_at, expires_at, (project,entity_type), (project,status)
synapses: source, target, axon, weight
sessions: project, date, created_at
connectors: type, status
```

### 2.6 Connector 현황

#### GitHub Connector

```
환경변수: GITHUB_TOKEN, GITHUB_REPOS
수집 대상:
  - Pull Requests -> entity_type: document (+ inferred decision if body has decision sections)
  - Issues -> entity_type: task
  - ADR files (docs/decisions/, docs/adr/) -> entity_type: decision
  - CODEOWNERS -> entity_type: person (ownership mapping)
동작 방식: REST API, paginated fetch, rate limit handling (429/403 retry)
Full sync: 최근 90일
Incremental sync: cursor (ISO date) 기반
```

#### Slack Connector

```
환경변수: SLACK_TOKEN, SLACK_CHANNELS
수집 대상:
  - Significant threads (reply_count >= 3) -> entity_type: conversation
  - Decision messages (패턴 매칭: "결정:", "decided:", "tl;dr:", "action item:") -> entity_type: decision
  - Highly reacted messages (reactions >= 3) -> entity_type: conversation
  - Channel members -> entity_type: person
필터링: 20자 미만, emoji only, 단순 응답(ok, thanks, lgtm) 제외
동작 방식: Web API, cursor-based pagination, rate limit handling (429 retry)
Full sync: 최근 30일
```

#### Notion Connector

```
환경변수: NOTION_TOKEN, NOTION_DATABASES (optional), NOTION_PAGES (optional)
수집 대상:
  - Pages -> entity_type: document
  - Database entries with status/checkbox properties -> entity_type: task
  - Block content (paragraph, heading, list, code, callout, quote 등 12+ block types)
동작 방식: Notion API v1, 350ms request delay (3 req/s rate limit), recursive block fetch (depth 2)
Full sync: 전체 accessible pages
Incremental sync: last_edited_time 기반
```

#### Calendar Connector (미구현)

```
대상: Google Calendar, Microsoft Outlook/Exchange
수집 예정: 회의 일정, 참석자, 첨부 링크, recurring event
entity_type: event, meeting
필요 사항: OAuth2 flow, token refresh, CalDAV or REST API
우선순위: P1 (Phase 1 목표)
```

### 2.7 이 레이어가 하지 않는 것

| 하지 않는 것 | 이유 | 담당 레이어 |
|-------------|------|-----------|
| **비정형 텍스트에서 decision/action 추출** | LLM 추론 필요 | Layer 2 |
| **Cross-source topic stitching** | Semantic understanding 필요 | Layer 2 |
| **Entity resolution (사람 매핑)** | 이름 변형/별칭 해석 필요 | Layer 2 |
| **Working pattern 분석** | 통계 분석 + 추론 필요 | Layer 2 or 별도 |
| **회의 요약 생성** | LLM 추론 필요 | Layer 3 |
| **주기적 briefing 생성** | Agent orchestration 필요 | Layer 3 |
| **업무 프로세스 개선 제안** | 복합 분석 필요 | Layer 3 |
| **사용자 인증/인가** | 현재 로컬 전용 | 추후 결정 |

---

## 3. Layer 2: Context Engine (신규)

### 3.1 책임 범위

Layer 1이 수집한 raw 데이터에 **의미(semantics)** 를 부여하는 레이어.

- Hive-Memory에 저장된 비정형 텍스트에서 decision, action item 추출
- 여러 소스의 같은 주제를 연결 (topic thread stitching)
- 서로 다른 소스의 같은 사람을 매핑 (entity resolution)
- 추출 결과를 다시 Hive-Memory에 enriched entity로 저장

### 3.2 왜 Hive-Memory와 분리해야 하는가

| 기준 | Layer 1 (Memory) | Layer 2 (Context Engine) |
|------|-----------------|------------------------|
| **LLM 의존성** | 없음 (by design) | 핵심 기능 |
| **비용** | 저장/검색만 (무료) | LLM API 호출 비용 발생 |
| **실행 빈도** | 실시간 (매 tool call) | 배치 or 이벤트 기반 |
| **장애 영향** | LLM 다운 시에도 기존 기억 사용 가능 | LLM 다운 시 새 추론 불가 |
| **배포 단위** | npm package (hive-memory) | 별도 서비스 or MCP server |
| **테스트 난이도** | 결정적 (deterministic) | 비결정적 (LLM 출력 변동) |
| **업그레이드 주기** | 드물게 (안정적) | 자주 (프롬프트 개선, 모델 교체) |

**핵심 이유**: Hive-Memory의 설계 원칙 "NO LLM"을 보존하면서도, LLM 기반 기능을 추가하려면 별도 레이어가 필요하다. Layer 1에 LLM을 넣으면 로컬 전용/zero-dependency라는 핵심 가치가 훼손된다.

### 3.3 핵심 기능

#### 3.3.1 Decision Extraction

```
입력: Hive-Memory의 conversation, document entity (Slack 대화, PR description, Notion 문서)
처리:
  1. Entity content에서 decision 후보 추출 (LLM or rule-based)
  2. Decision의 context, rationale, alternatives, owner 구조화
  3. 결과를 Hive-Memory에 entity_type: decision, confidence: inferred로 저장
  4. 원본 entity와 extracted decision 사이에 "derived" synapse 생성
출력: 새로운 decision entity + derived synapse

LLM 프롬프트 예시:
  "다음 대화에서 내려진 결정(decision)을 추출하세요.
   각 결정에 대해: 결정 내용, 맥락, 근거, 담당자를 구조화하세요.
   결정이 없으면 빈 배열을 반환하세요."

Rule-based fallback:
  - 패턴 매칭: "결정:", "decided:", "we'll go with", "let's use" 등
  - Slack connector의 기존 DECISION_PATTERNS 확장
```

#### 3.3.2 Action Item Extraction

```
입력: conversation, meeting, document entity
처리:
  1. Content에서 action item 추출 (LLM or rule-based)
  2. 각 action의 담당자, 기한, 상태 구조화
  3. entity_type: task, confidence: inferred로 저장
  4. 원본 entity와 extracted task 사이에 "derived" synapse 생성
  5. 담당자 person entity와 "authored" synapse 생성
출력: 새로운 task entity + derived/authored synapses

LLM 프롬프트 예시:
  "다음 텍스트에서 action item(해야 할 일)을 추출하세요.
   각 항목에 대해: 내용, 담당자, 기한, 우선순위를 구조화하세요."

Rule-based fallback:
  - 패턴 매칭: "TODO:", "할 일:", "@사람 ~해주세요", "by [날짜]" 등
```

#### 3.3.3 Topic Thread Stitching

```
입력: 모든 entity (cross-source)
처리:
  1. memory_trail로 특정 topic 관련 entity 조회
  2. LLM으로 semantic similarity 판단 (keyword 기반 FTS5로 부족한 부분 보완)
  3. 같은 주제의 entity 간 "semantic" synapse 생성/강화
  4. Topic thread summary 생성
출력: 새로운/강화된 semantic synapses + topic summary entity

예시:
  Slack "#backend-arch" 채널의 "DB 마이그레이션" 대화
  + Notion "Architecture Decisions" 문서의 "PostgreSQL -> MySQL" 섹션
  + GitHub PR #42 "Migrate database schema"
  => 3개 entity 사이에 semantic synapse 생성
```

#### 3.3.4 Entity Resolution (Cross-Source Person Mapping)

```
입력: entity_type: person (모든 소스에서 수집된 사람 entity)
처리:
  1. 소스별 사람 entity 수집:
     - GitHub: login (e.g., cheolsu-kim)
     - Slack: userId + real_name + display_name (e.g., 김철수)
     - Notion: user id + name
  2. 매칭 전략 (우선순위 순):
     a. 정확히 같은 이름 -> 자동 매핑
     b. email 기반 (소스에 email 포함 시) -> 자동 매핑
     c. 유사 이름 (LLM or fuzzy matching) -> 후보 제시, 사람이 확인
  3. 매핑된 person entity 간 "semantic" synapse (weight: 1.0) 생성
  4. 대표 person entity 지정, 나머지는 superseded_by로 연결
출력: 통합된 person entity + supersedes synapses

데이터 구조 (attributes):
  {
    "identities": [
      { "source": "github", "login": "cheolsu-kim" },
      { "source": "slack", "userId": "U12345", "displayName": "김철수" },
      { "source": "notion", "userId": "abc123", "name": "Cheolsu Kim" }
    ]
  }
```

#### 3.3.5 Working Pattern (별도 논의 필요)

```
정의: 팀원/팀의 업무 패턴 분석 (어떤 시간에 일하는지, 협업 패턴, 반복 작업 등)
현재 상태: 미설계
이유:
  - 프라이버시 우려 (개인 업무 패턴 추적)
  - 다른 기능들과 성격이 다름 (analytics에 가까움)
  - Layer 2의 다른 기능들이 선행 필요 (entity resolution 없이는 불가)
권장: Phase 2 완료 후 별도 논의. Layer 2의 sub-module 또는 별도 analytics 서비스로 구현.
```

### 3.4 LLM 사용 전략

#### 환경변수 제어

```bash
CORTEX_ENRICHMENT=rule|llm|off

# rule: 패턴 매칭/규칙 기반만 사용 (LLM 비용 없음, 정확도 낮음)
# llm: LLM 추론 사용 (비용 발생, 정확도 높음)
# off: enrichment 비활성화 (raw data만 저장)
```

#### LLM Provider

```bash
CORTEX_LLM_PROVIDER=openai|anthropic|local
CORTEX_LLM_MODEL=gpt-4o-mini|claude-3-haiku|ollama:llama3
CORTEX_LLM_API_KEY=sk-...
```

#### 비용 제어

| 전략 | 설명 |
|------|------|
| **Batch processing** | 실시간이 아닌 주기적 배치 (hourly/daily) |
| **Small model first** | gpt-4o-mini / claude-3-haiku 등 저비용 모델 우선 |
| **Rule-based prefilter** | LLM 호출 전에 rule-based로 후보 필터링 |
| **Cache** | 동일 input에 대한 LLM 응답 캐싱 |
| **Budget cap** | 월별/일별 LLM API 비용 상한 설정 |

#### EnrichmentProvider Interface

```typescript
interface EnrichmentProvider {
  readonly id: string;
  readonly name: string;

  // Decision extraction from unstructured text
  extractDecisions(text: string, context?: EnrichmentContext): Promise<ExtractedDecision[]>;

  // Action item extraction
  extractActions(text: string, context?: EnrichmentContext): Promise<ExtractedAction[]>;

  // Topic similarity judgment
  assessTopicSimilarity(a: string, b: string): Promise<number>;  // 0.0 ~ 1.0

  // Person name matching
  matchPersonIdentities(candidates: PersonCandidate[]): Promise<PersonMatch[]>;
}

// 두 가지 구현체:
class RuleBasedEnrichment implements EnrichmentProvider { ... }
class LLMEnrichment implements EnrichmentProvider { ... }
```

### 3.5 Hive-Memory와의 인터페이스

Context Engine은 Hive-Memory를 **MCP client**로 사용한다.

#### 읽기 (Input)

| 사용하는 Tool | 용도 |
|-------------|------|
| `memory_grep` | 특정 패턴의 entity 검색 (decision 후보 등) |
| `memory_trail` | Cross-domain topic 조회 |
| `memory_timeline` | 시간순 entity 조회 (배치 처리 범위 결정) |
| `memory_inspect` | 개별 entity 상세 조회 |
| `memory_who` | 특정 topic의 전문가 조회 (entity resolution 보조) |
| `connector_status` | Connector sync 상태 확인 (새 데이터 유무) |

#### 쓰기 (Output)

| 사용하는 Tool | 용도 |
|-------------|------|
| `memory_store` | 추출된 decision/action을 새 entity로 저장 |
| `memory_link` | Entity 간 synapse 생성 (derived, semantic, authored 등) |

#### 데이터 흐름

```
1. connector_sync가 Slack/GitHub/Notion에서 raw entity 수집 (Layer 1)
2. Context Engine이 memory_timeline으로 새로 들어온 entity 확인
3. 각 entity에 대해 enrichment 실행:
   - extractDecisions() -> memory_store (decision) + memory_link (derived)
   - extractActions() -> memory_store (task) + memory_link (derived)
4. 주기적으로 topic stitching 실행:
   - memory_trail -> assessTopicSimilarity -> memory_link (semantic)
5. 주기적으로 entity resolution 실행:
   - memory_grep (person) -> matchPersonIdentities -> memory_link (supersedes)
```

### 3.6 구현 옵션

#### Option A: 별도 MCP Server

```
장점: Layer 1과 완전 분리, 독립 배포, 다른 MCP client에서도 사용 가능
단점: MCP-over-MCP 통신 복잡도, 두 서버 관리 필요
구조: context-engine (MCP server) -> hive-memory (MCP server) -> SQLite
```

#### Option B: Hive-Memory Plugin

```
장점: 단일 서버, 통신 오버헤드 없음, 배포 단순
단점: Layer 1의 "NO LLM" 원칙 부분 위반 (같은 프로세스), 의존성 증가
구조: hive-memory (MCP server + enrichment plugin) -> SQLite
```

#### Option C: Standalone 배치 서비스 (권장)

```
장점: 실시간 부담 없음, 비용 예측 가능, Layer 1 완전 보존
단점: 실시간 enrichment 불가 (분~시간 단위 지연)
구조: context-engine (cron/event service) --MCP client--> hive-memory (MCP server) -> SQLite
```

**권장**: Option C. Context Engine은 주기적으로 실행되는 배치 서비스로, MCP client 라이브러리를 사용하여 Hive-Memory에 접근한다. 실시간 요구사항이 생기면 Option A로 전환 가능.

---

## 4. Layer 3: Agent Layer (별도 프로젝트)

### 4.1 왜 별도 프로젝트인가

| 이유 | 설명 |
|------|------|
| **다른 실행 모델** | Agent는 대화형(interactive) or 이벤트 기반. Memory/Context는 도구(tool) |
| **다른 기술 스택** | Agent는 LLM orchestration framework (LangChain, AutoGen 등) 필요 가능 |
| **다른 배포 주기** | Agent는 프롬프트 튜닝으로 자주 업데이트 |
| **다른 사용자 인터페이스** | Agent는 Slack bot, CLI, 웹 UI 등 다양한 frontend 필요 |
| **독립적 발전** | Agent는 Hive-Memory 없이도 다른 memory system과 조합 가능 |

### 4.2 Meeting Agent 스펙

#### 역할

회의 전후 컨텍스트를 자동으로 준비하고, 회의 결과를 구조화하여 반영한다.

#### 트리거

```
1. 회의 30분 전: Calendar event 감지 -> 사전 브리핑 생성
2. 회의 직후: Transcript 업로드 or 녹음 파일 -> 후처리 실행
3. 수동: 사용자가 Agent에게 요청
```

#### 기능

```
[사전 브리핑]
- 참석자 관련 최근 활동 조회 (memory_who)
- 회의 주제 관련 기존 결정/논의 조회 (memory_trail)
- 이전 회의 후속 action item 상태 확인
- 브리핑 문서 생성 -> Notion/Slack에 공유

[후처리]
- Transcript에서 decision/action 추출 (Layer 2 활용)
- 구조화된 회의록 생성:
  - 참석자
  - 논의 주제별 요약
  - 결정 사항 (누가, 무엇을, 왜)
  - Action items (담당자, 기한)
  - 다음 회의 안건
- 결과를 Hive-Memory에 저장 (memory_store)
- Slack 채널에 요약 공유
- Notion 페이지에 회의록 생성

[후속 추적]
- Action item 기한 도래 시 알림
- 다음 회의 전에 미완료 action item 리마인더
```

#### 입력/출력

```
입력:
  - Calendar event (참석자, 주제, 시간)
  - Meeting transcript (텍스트 or 음성 -> STT)
  - 기존 Hive-Memory 데이터 (MCP tools)

출력:
  - 사전 브리핑 (Markdown)
  - 구조화된 회의록 (Markdown)
  - Hive-Memory entities (meeting, decision, task)
  - Slack 메시지
  - Notion 페이지
```

### 4.3 Memory Steward 스펙

#### 역할

Hive-Memory의 데이터 품질을 주기적으로 관리하고, 사용자에게 context briefing을 제공한다.

#### 트리거

```
1. 매일 아침: 일간 브리핑 생성
2. 매주 월요일: 주간 브리핑 생성
3. Connector sync 후: 새 데이터 품질 검토
4. 수동: 사용자 요청
```

#### 기능

```
[데이터 품질 관리]
- 중복 entity 탐지 및 병합 제안 (memory_grep으로 유사 content 검색)
- Stale entity 탐지 (memory_decay dry_run)
- 누락된 synapse 제안 (관련성 높은데 연결 안 된 entity)
- Confidence: inferred entity 검토 요청 (사람 확인 필요한 것)

[브리핑 생성]
- 일간: 어제 새로 들어온 주요 entity 요약
- 주간: 이번 주 결정 사항, 완료/미완료 action item, 새로운 topic thread
- 프로젝트별: 특정 프로젝트의 최근 컨텍스트 요약

[Proactive 알림]
- 결정 충돌 감지 (conflict synapse 발생 시)
- 오래된 결정에 대한 review 제안
- 담당자 없는 action item 알림
```

### 4.4 Workflow Advisor 스펙

#### 역할

축적된 데이터에서 팀의 업무 패턴을 분석하고, 프로세스 개선을 제안한다.

#### 트리거

```
1. 월간: 월간 패턴 분석 리포트
2. 수동: 사용자 요청
```

#### 기능

```
[패턴 분석] (Working Pattern Memory 의존 -- Phase 3+ 이후)
- 결정 패턴: 어떤 유형의 결정이 많은지, 결정까지 걸리는 시간
- 협업 패턴: 누가 누구와 자주 같은 topic에서 활동하는지
- 병목 패턴: Action item이 자주 지연되는 영역
- 반복 패턴: 비슷한 결정/논의가 반복되는 주제

[개선 제안]
- "이 주제는 3번째 논의입니다. 이전 결정을 참고하세요: [link]"
- "이 action item 유형은 평균 5일 지연됩니다. 자동화를 고려하세요."
- "A팀과 B팀이 같은 주제를 독립적으로 논의 중입니다."
```

#### 우선순위

Workflow Advisor는 Layer 2의 Entity Resolution + Topic Stitching이 충분히 성숙한 후에만 의미있다. **Phase 3에서 가장 마지막에 구현.**

### 4.5 Agent가 사용하는 Hive-Memory 도구

| Agent | 주로 사용하는 Tool | 용도 |
|-------|-----------------|------|
| Meeting Agent | `memory_trail`, `memory_who`, `memory_store`, `memory_link` | 주제 추적, 전문가 조회, 회의록 저장 |
| Meeting Agent | `memory_timeline`, `memory_grep` | 이전 회의/결정 조회 |
| Memory Steward | `memory_decay`, `memory_grep`, `memory_inspect` | 품질 관리 |
| Memory Steward | `memory_timeline`, `memory_tree`, `memory_ls` | 브리핑용 데이터 조회 |
| Workflow Advisor | `memory_trail`, `memory_who`, `memory_traverse` | 패턴 분석 |
| Workflow Advisor | `connector_status` | 데이터 소스 상태 확인 |

---

## 5. PM 요구사항 대비 매핑

### 5.1 Memory Types별 매핑

| Memory Type | Layer | 현재 상태 | 필요한 작업 |
|---|---|---|---|
| **Artifact Memory** (문서, 코드, 대화 원본) | Layer 1 (Hive-Memory) | :white_check_mark: GitHub/Slack/Notion connector 동작 | Calendar connector 추가 |
| **Decision Memory** (결정 사항) | Layer 1 (저장) + Layer 2 (추출) | :large_orange_diamond: explicit만 (패턴 매칭) | Layer 2에서 LLM 기반 추출 |
| **Action Memory** (해야 할 일) | Layer 1 (저장) + Layer 2 (추출) | :x: 미구현 | Layer 2에서 action item extraction 구현 |
| **Topic Thread Memory** (주제별 맥락) | Layer 1 (trail tool) + Layer 2 (stitching) | :large_orange_diamond: FTS5 기반만 | Layer 2에서 semantic stitching |
| **Working Pattern Memory** (업무 패턴) | Layer 2 or 별도 Analytics | :x: 미구현 | 별도 논의 필요 (Phase 3+ 이후) |

### 5.2 Integration별 매핑

| Integration | Layer | 현재 상태 | 남은 작업 |
|---|---|---|---|
| **Slack** | Layer 1 (connector) | :white_check_mark: 동작 중 | signal filter 튜닝, thread context 개선 |
| **Notion** | Layer 1 (connector) | :white_check_mark: 동작 중 | database property 매핑 개선 |
| **Google Calendar** | Layer 1 (connector) | :x: 미구현 | OAuth2 + Calendar API 구현 (Phase 1) |
| **Google Meet/Zoom** | Layer 3 (Meeting Agent) | :x: 미구현 | Transcript 연동 (Phase 3) |
| **GitHub** | Layer 1 (connector) | :white_check_mark: 동작 중 | PR review comment 추가 수집 고려 |

### 5.3 Agent별 매핑

| Agent | Layer | 현재 상태 | 비고 |
|---|---|---|---|
| **Meeting Agent** | Layer 3 (별도 프로젝트) | :x: 미구현 | Calendar connector (L1) + Decision extraction (L2) 선행 필요 |
| **Memory Steward** | Layer 3 (별도 프로젝트) | :x: 미구현 | 기존 memory_decay tool 활용 가능 |
| **Workflow Advisor** | Layer 3 (별도 프로젝트) | :x: 미구현 | Entity Resolution (L2) + 충분한 데이터 축적 선행 필요 |

---

## 6. 요구사항에서 삭제/수정이 필요한 항목

### 6.1 Working Pattern Memory: 왜 분리해야 하는지

PM 요구사항은 Working Pattern을 다른 Memory Type과 동일 레이어에 배치했으나, 이는 성격이 다르다.

| 다른 Memory Types | Working Pattern |
|------------------|----------------|
| 개별 아티팩트 저장 (entity) | 집계/통계 (aggregation) |
| 수집 시점에 생성 | 분석 시점에 생성 |
| 사실 기반 (factual) | 해석 기반 (interpretive) |
| 프라이버시 이슈 낮음 | 개인 업무 추적 -- 프라이버시 우려 |

**권장**: Working Pattern은 Layer 2의 sub-module이 아닌 **별도 analytics 서비스**로 분리. Entity Resolution과 Topic Stitching이 완료된 후 Phase 3+에서 논의.

### 6.2 Context Structuring이 LLM을 필요로 하는 이유 명시

PM 요구사항은 "Context Structuring"을 언급했지만, 이것이 왜 rule-based로는 부족한지 명시하지 않았다.

**명시해야 하는 점**:

```
1. Decision Extraction:
   - Rule-based: "결정:", "decided:" 패턴만 잡음 -> recall ~30%
   - LLM: "이 방향으로 가자", "A 대신 B를 쓰기로 했음" 등 자연어 표현 -> recall ~80%

2. Action Item Extraction:
   - Rule-based: "TODO:", "@사람" 패턴만 잡음
   - LLM: "내일까지 검토 부탁드려요", "다음 주에 한번 보자" 등 -> 암묵적 요청 포착

3. Topic Stitching:
   - FTS5: keyword 일치만 (동의어, 약어, 다국어 처리 불가)
   - LLM: "DB migration" = "데이터베이스 이전" = "스키마 변경" 이해

4. Entity Resolution:
   - Rule-based: 정확한 이름 매칭만
   - LLM: "김철수" = "Cheolsu Kim" = "cheolsu-kim" 추론
```

**결론**: LLM 없이도 동작하지만(rule-based fallback), 실용적 수준의 정확도를 위해서는 LLM이 필요하다. 따라서 CORTEX_ENRICHMENT=rule|llm|off 3단계 제어가 반드시 필요.

### 6.3 누락된 요구사항

#### Authentication & Authorization

```
현재: 없음. 로컬 전용이므로 파일 시스템 권한에 의존.
필요한 시점: 팀 공유(team sync) 또는 서버 배포 시
수준:
  - Phase 1: 없음 (로컬 전용)
  - Phase 2: API key 기반 (connector 인증만)
  - Phase 3+: OAuth2 / SSO (팀 서버 배포 시)
```

#### GDPR / Privacy

```
현재: 데이터가 로컬 머신에만 저장 (~/.cortex/cortex.db)
우려:
  - Slack 대화에 개인정보 포함 가능
  - Person entity에 실명/이메일 저장
  - Working Pattern은 개인 업무 추적에 해당
필요한 조치:
  - 데이터 보관 기간 정책 (expires_at 활용)
  - 개인정보 마스킹 옵션 (connector 레벨)
  - 삭제 요청 처리 (entity soft delete -> hard delete)
  - Team sync 시 개인정보 필터링
```

#### Scale

```
현재 기준: 개인 또는 소규모 팀 (entity 수만 개 수준)
SQLite 한계:
  - 읽기: WAL 모드로 concurrent read 가능. 수십만 entity까지 문제 없음.
  - 쓰기: single writer. connector 동시 sync 시 직렬화 필요.
  - FTS5: 수십만 entity까지는 ms 단위 응답.
확장 시나리오:
  - 50인 팀: entity 10-50만. SQLite 충분. team sync로 분산.
  - 200인+ 조직: PostgreSQL + pgvector 전환 검토. 별도 ADR 필요.
```

#### Deployment

```
현재: 로컬 실행 (npm install -g hive-memory)
옵션:
  - 로컬 (현재): 개인용. 설정 간단. 프라이버시 최상.
  - Docker: 팀 서버용. Connector scheduling 포함.
  - Cloud: SaaS형. Multi-tenant. Phase 3+ 이후 검토.
Phase 1 목표: 로컬 유지.
Phase 2 목표: Docker compose (hive-memory + context-engine).
Phase 3 목표: Helm chart / Cloud Run 배포 옵션.
```

---

## 7. 실행 로드맵

### Phase 1 (4주): Memory System 완성

```
목표: Hive-Memory의 남은 gap을 채워서 모든 데이터 소스 연동 완료
팀: 1 백엔드 엔지니어

Week 1-2: Calendar Connector
  - Google Calendar API OAuth2 flow 구현
  - ConnectorPlugin interface 준수 (fullSync, incrementalSync, transform)
  - entity_type: event (일정), meeting (회의)
  - 참석자 -> entity_type: person
  - 테스트: mock calendar data + integration test

Week 3: Entity Deduplication 강화
  - source_external_id 기반 upsert 로직 보강
  - 같은 external_id로 들어온 entity의 updated_at 갱신
  - Connector error recovery (partial sync resume)

Week 4: 안정화 + 문서화
  - 모든 connector에 대한 end-to-end 테스트
  - Connector 설정 가이드 작성
  - 환경변수/설정 검증 도구

산출물:
  - Calendar connector (Google Calendar)
  - Entity deduplication 개선
  - 전체 connector 통합 테스트

Kill conditions:
  - Google Calendar API 접근 불가 (조직 정책 차단) -> Outlook 우선 전환
  - OAuth2 flow가 MCP 환경에서 불가 -> 수동 token 입력 방식 대체
```

### Phase 2 (6주): Context Engine MVP

```
목표: Decision/Action extraction을 LLM opt-in으로 구현
팀: 1 백엔드 + 0.5 ML 엔지니어

Week 1-2: EnrichmentProvider 프레임워크
  - EnrichmentProvider interface 정의
  - RuleBasedEnrichment 구현 (기존 패턴 확장)
  - LLMEnrichment 구현 (OpenAI gpt-4o-mini 기본)
  - CORTEX_ENRICHMENT 환경변수 제어
  - MCP client로 Hive-Memory 연결

Week 3-4: Decision + Action Extraction
  - Decision extraction 프롬프트 설계 + 평가
  - Action item extraction 프롬프트 설계 + 평가
  - Extraction 결과를 Hive-Memory에 저장 (memory_store + memory_link)
  - Rule-based vs LLM 정확도 비교 벤치마크

Week 5: Entity Resolution MVP
  - Person entity 수집 (전 소스)
  - 정확 이름 매칭 (rule-based)
  - LLM fuzzy matching (optional)
  - Person merge flow (superseded_by + identities attribute)

Week 6: 통합 + 배치 스케줄링
  - Cron-based 배치 실행 (hourly enrichment)
  - Docker compose (hive-memory + context-engine)
  - End-to-end 테스트: Slack 대화 -> decision 추출 -> Hive-Memory 저장

산출물:
  - Context Engine 서비스 (standalone, MCP client)
  - Decision extraction (rule + LLM)
  - Action item extraction (rule + LLM)
  - Entity resolution MVP
  - Docker compose 배포 구성

Kill conditions:
  - LLM extraction 정확도 < 60% (F1) -> rule-based에 집중, 프롬프트 재설계
  - LLM 비용이 $100/월 초과 (소규모 팀 기준) -> 모델 다운그레이드 or 배치 주기 늘림
  - MCP client -> MCP server 통신이 불안정 -> direct SQLite 접근으로 전환 (원칙 위반이지만 실용적 대안)
```

### Phase 3 (8주): Agent Layer MVP

```
목표: Meeting Agent 우선 구현, Memory Steward 기본 기능
팀: 1.5 백엔드 + 0.5 프론트엔드

Week 1-2: Agent 프레임워크
  - Agent 실행 환경 (event-driven + scheduled)
  - MCP client 연결 (Hive-Memory + Context Engine)
  - Agent -> Slack/Notion output adapter

Week 3-5: Meeting Agent
  - Calendar event 감지 -> 사전 브리핑 생성
  - Meeting transcript -> 후처리 (Layer 2 활용)
  - 구조화된 회의록 -> Notion 페이지 생성
  - Action item -> Slack 알림
  - 후속 추적 (action item 기한 리마인더)

Week 6-7: Memory Steward (기본)
  - 일간 브리핑 생성 (새 entity 요약)
  - memory_decay 자동 실행 (주간)
  - 중복 entity 탐지 알림
  - Confidence: inferred entity 검토 요청

Week 8: 통합 + 사용자 테스트
  - 전체 시스템 end-to-end 테스트
  - 실제 팀 데이터로 파일럿 테스트
  - 사용자 피드백 수집
  - Workflow Advisor는 Phase 4로 연기

산출물:
  - Meeting Agent (calendar -> 브리핑 -> 회의록 -> 후속추적)
  - Memory Steward (일간 브리핑 + 품질 관리)
  - 전체 시스템 Docker compose
  - 사용자 가이드

Kill conditions:
  - Meeting transcript 확보 불가 (Google Meet/Zoom API 제한) -> 수동 업로드 방식
  - Slack bot 승인 불가 (조직 정책) -> CLI 전용 모드
  - 사용자 피드백에서 "오히려 방해" -> Agent 자동 실행 off, 수동 트리거만 유지
```

---

## 8. 기술적 결정 사항

### 8.1 LLM: 어디서, 어떻게, 얼마나

| 항목 | 결정 |
|------|------|
| **어디서** | Layer 2 (Context Engine) + Layer 3 (Agent Layer) only. Layer 1 never. |
| **어떻게** | OpenAI API 기본. Anthropic/local(Ollama) 교체 가능. EnrichmentProvider interface로 추상화. |
| **얼마나** | Phase 2: gpt-4o-mini 기준 월 $10-30 (소규모 팀). 배치 처리로 비용 제어. |
| **Fallback** | CORTEX_ENRICHMENT=rule로 LLM 없이 동작 가능 (정확도 저하 감수) |

### 8.2 Deployment: Local vs Server

| Phase | 배포 방식 | 이유 |
|-------|---------|------|
| Phase 1 | 로컬 (`npm install -g`) | 개인 개발자 대상. 설정 최소화. |
| Phase 2 | Docker Compose | Context Engine은 배치 서비스이므로 서버 필요. |
| Phase 3 | Docker Compose + 선택적 Cloud | Agent는 항상 실행 상태 필요. |

### 8.3 Auth: 어떤 수준이 필요한가

| Phase | 인증 수준 | 대상 |
|-------|---------|------|
| Phase 1 | 없음 | 로컬 파일 시스템 권한으로 충분 |
| Phase 2 | API key | Connector 외부 서비스 인증 (이미 환경변수로 구현) |
| Phase 3 | OAuth2 (선택) | 팀 서버 배포 시 사용자 인증 필요 |

### 8.4 Scale: 어떤 규모를 목표로 하는가

| 규모 | Entity 수 | 기술 스택 | 비고 |
|------|----------|---------|------|
| 개인 (Phase 1) | ~1만 | SQLite | 현재 아키텍처 충분 |
| 소규모 팀 5-20인 (Phase 2-3) | ~10만 | SQLite + WAL | Team sync로 분산 |
| 중규모 팀 20-50인 | ~50만 | SQLite 한계 도달 가능 | FTS5 성능 모니터링 필요 |
| 대규모 조직 50인+ | 100만+ | PostgreSQL 전환 검토 | 별도 ADR 필요 |

---

## Appendix A: 환경변수 총정리

### Layer 1 (Hive-Memory) -- 현재

```bash
CORTEX_DATA_DIR=~/.cortex           # 데이터 저장 경로
CORTEX_LOCAL_SYNC=true              # .cortex.md 파일 동기화 여부
CORTEX_LOCAL_FILENAME=.cortex.md    # 로컬 컨텍스트 파일명

# Connectors
GITHUB_TOKEN=ghp_...               # GitHub Personal Access Token
GITHUB_REPOS=owner/repo1,owner/repo2

SLACK_TOKEN=xoxb-...               # Slack Bot Token
SLACK_CHANNELS=C12345,C67890

NOTION_TOKEN=secret_...            # Notion Integration Token
NOTION_DATABASES=db-id-1,db-id-2   # (optional)
NOTION_PAGES=page-id-1             # (optional)
```

### Layer 2 (Context Engine) -- 신규 (예정)

```bash
CORTEX_ENRICHMENT=rule|llm|off     # enrichment 모드
CORTEX_LLM_PROVIDER=openai         # LLM provider
CORTEX_LLM_MODEL=gpt-4o-mini      # LLM model
CORTEX_LLM_API_KEY=sk-...         # LLM API key
CORTEX_ENRICHMENT_SCHEDULE=0 * * * *  # 배치 주기 (cron)
CORTEX_ENRICHMENT_BUDGET=30        # 월간 LLM 비용 상한 ($)
```

## Appendix B: 용어 정리

| 용어 | 정의 |
|------|------|
| **Entity** | Hive-Memory의 기본 저장 단위. 12가지 type. |
| **Synapse** | Entity 간 방향성 가중 연결. 14가지 axon type. |
| **Axon** | Synapse의 연결 유형 (temporal, causal, semantic 등) |
| **Spreading Activation** | Seed entity에서 synapse를 따라 signal을 전파하는 그래프 검색 알고리즘 |
| **Hebbian Learning** | "함께 활성화되는 뉴런은 함께 연결된다." Co-activation 기반 자동 synapse 생성. |
| **LTP/LTD** | Long-Term Potentiation / Depression. Synapse weight 강화/약화. |
| **Connector** | 외부 데이터 소스에서 raw document를 가져와 entity로 변환하는 플러그인. |
| **EnrichmentProvider** | Context Engine의 추론 인터페이스. Rule-based 또는 LLM 구현체. |
| **MCP** | Model Context Protocol. AI Agent와 Tool Server 간 통신 프로토콜. |
| **FTS5** | SQLite Full-Text Search 5. BM25 ranking 지원. |
| **WAL** | Write-Ahead Logging. SQLite의 concurrent read 모드. |
| **RRF** | Reciprocal Rank Fusion. FTS5 + graph 검색 결과를 결합하는 알고리즘. |
