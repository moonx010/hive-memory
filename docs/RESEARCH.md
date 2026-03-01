# Cortex Research Notes

## 기존 솔루션 조사 (2026-02)

### 범용 에이전트 메모리 시스템

| 도구 | Stars | 핵심 특징 | 한계 |
|------|-------|-----------|------|
| [Mem0](https://github.com/mem0ai/mem0) | 41k+ | 토큰 90% 절감, 에피소딕/시맨틱/절차적 메모리 | 범용 프레임워크용, Claude Code 전용 아님 |
| [Letta/MemGPT](https://github.com/letta-ai/letta) | - | OS 가상메모리 패턴, Context Repositories (Git 기반) | 자체 에이전트 플랫폼에 종속 |
| [Zep/Graphiti](https://github.com/getzep/graphiti) | 20k+ | 시간 인지 지식 그래프, DMR 벤치마크 1위 | Neo4j 의존성 |
| [OpenMemory](https://github.com/CaviraOSS/OpenMemory) | - | 로컬 우선, MCP 네이티브, 5개 메모리 섹터 | 신규 프로젝트 |
| [MemOS](https://github.com/MemTensor/MemOS) | - | "메모리 OS", 크로스-프로젝트 공유 명시 설계 | 신규 (2025.05) |

### Claude Code 메모리 확장 플러그인

| 도구 | 특징 |
|------|------|
| [Claude-Mem](https://github.com/thedotmack/claude-mem) | 세션 활동 자동 캡처, AI 압축 |
| [Memsearch](https://github.com/zilliztech/memsearch) | 마크다운 기반, 벡터 인덱스, Zilliz/Milvus |
| [Claude-Supermemory](https://github.com/supermemoryai/claude-supermemory) | 크로스-프로젝트 프로필 (유료) |

### MCP 메모리 서버

| 서버 | 특징 |
|------|------|
| [공식 Knowledge Graph Memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) | 엔티티-관계-관찰 모델, 기본적 |
| [xgmem](https://github.com/meetdhanani17/xgmem) | 프로젝트별 + 크로스-프로젝트 지식 그래프 |
| [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) | 5ms 검색, 다중 에이전트 지원 |

### 차별화 포인트

기존 도구들은 대부분:
- 범용 에이전트 프레임워크용 (LangChain, CrewAI 등)이거나
- 단순 CRUD 지식 그래프이거나
- 단일 프로젝트 범위

**Cortex의 차별점**: Claude Code 사용자가 여러 프로젝트를 병렬 작업할 때,
"저번에 했던 ~~ 작업 어떻게 돼?" 한마디로 컨텍스트를 복원할 수 있는 전용 도구.

## 핵심 설계 인사이트

### 토큰 효율성
- Mem0: 대화당 1.8K 토큰 (전체 컨텍스트 26K 대비 90% 절감)
- 핵심: Extraction → Update → Retrieval 파이프라인
- Progressive Disclosure: 요약은 항상 로드, 상세는 필요시만

### 아키텍처 패턴
- Hub-and-Spoke: 중앙 요약 + 프로젝트별 상세
- Letta Context Repositories: Git 기반 메모리 버전 관리, 파일 트리 = 네비게이션 인덱스
- 동기화: 세션 종료 시 자동 요약 push, 시작 시 관련 업데이트 pull

### 저장소 단계적 진화
1. Markdown/JSON (0-5 프로젝트) → 즉시 시작
2. SQLite + FTS5 (5-20 프로젝트) → 전문 검색
3. SQLite + sqlite-vec (20+ 프로젝트) → 시맨틱 검색

### 충돌 해결
- append-only + 주기적 LLM defragmentation이 가장 실용적
