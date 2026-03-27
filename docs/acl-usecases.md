# ACL Use Cases — Group-Based Access Control

## Use Case 1: 유저 생성 및 팀 배정

**Actor**: Admin
**Flow**:
1. Admin이 `user_manage(action="add", name="김철수", email="cheolsu@company.com")` 실행
2. 시스템이 API key 발급 (`hm_xxx...`)
3. Admin이 `group_manage(action="add_member", group="engineering", user="cheolsu")` 실행
4. 김철수가 engineering 그룹의 모든 팀 데이터에 접근 가능

**검증 포인트**:
- 유저 생성 직후에는 아무 그룹에도 속하지 않음 → `private` + `public` entity만 접근 가능
- 그룹 배정 후 해당 그룹의 `team` visibility entity에 접근 가능

---

## Use Case 2: 유저 삭제 및 접근 즉시 차단

**Actor**: Admin
**Flow**:
1. 김철수 퇴사 → Admin이 `user_manage(action="revoke", id="cheolsu-id")` 실행
2. 즉시 API key 무효화
3. 모든 그룹 멤버십 자동 제거
4. 김철수가 작성한 entity의 owner_id는 유지 (데이터 보존)
5. 다른 유저가 김철수의 private entity에 접근 불가 (orphaned)

**검증 포인트**:
- revoke 후 즉시 401 반환 (캐시 없음)
- 그룹 멤버십 cascade 삭제
- 기존 데이터는 삭제되지 않음

---

## Use Case 3: 그룹 자동 생성 (Slack 채널 sync)

**Actor**: System (Connector)
**Flow**:
1. Slack connector가 `#product-design` (private channel) sync
2. 시스템이 `slack:product-design` 그룹 자동 생성
3. 채널 멤버를 그룹 멤버로 자동 매핑 (Slack user → hive user, email 기준)
4. 해당 채널의 메시지 entity에 `required_groups: ["slack:product-design"]` 설정
5. 채널 멤버만 해당 메시지 검색/조회 가능

**검증 포인트**:
- Slack 멤버가 hive 유저로 매핑 안 되면 그룹에 추가 안 함 (silent skip)
- 채널에서 제거된 멤버는 다음 sync 시 그룹에서도 제거
- public 채널은 `required_groups` 없이 `visibility: org` 로 설정

---

## Use Case 4: C-level 미팅록 접근 제한

**Actor**: Admin
**Flow**:
1. Admin이 `exec-team` 그룹 수동 생성
2. CEO, CFO, COO를 `exec-team` 그룹에 추가
3. 경영 회의 미팅록이 들어오면 `required_groups: ["exec-team"]` 설정
4. 평사원이 `memory_recall("이사회")` → 해당 entity는 결과에 안 나옴

**검증 포인트**:
- 검색 결과에 존재 자체가 노출되지 않음 (silent denial)
- exec-team 멤버가 검색하면 정상 반환
- 미팅 참석자가 exec-team이 아니어도 `acl_members`에 포함되면 접근 가능?
  → **결정 필요**: required_groups AND acl_members 중 어떤 게 우선?

---

## Use Case 5: 내 개인 메모/일정을 다른 사람이 못 보게

**Actor**: 일반 유저
**Flow**:
1. 유저가 `memory_store(project="personal", content="이직 고민 중")` 실행
2. 시스템이 `owner_id: user_id, visibility: private` 자동 설정
3. 다른 유저가 `memory_recall("이직")` → 결과 없음
4. 본인만 검색 시 나타남

**검증 포인트**:
- visibility=private는 owner_id만 접근
- admin도 접근 불가? → **결정 필요**: admin 전체 접근 vs 프라이버시 보호

---

## Use Case 6: 권한 위임 (팀장이 팀원에게 특정 그룹 접근 부여)

**Actor**: Group Admin (팀장)
**Flow**:
1. 팀장이 인턴에게 `finance-review` 그룹 접근 부여 요청
2. 시스템이 팀장의 권한 확인 → 팀장이 해당 그룹의 admin인지?
3. 그룹 admin이면 멤버 추가 허용
4. 전체 시스템 admin이 아니어도 자기 그룹 관리 가능

**검증 포인트**:
- 그룹별 admin 역할 필요?
- 아니면 전체 admin만 그룹 관리 가능? → **결정 필요**

---

## Use Case 7: 검색 결과에서 권한별 다른 결과

**Actor**: 두 명의 유저 (동시 검색)
**Flow**:
1. CEO (groups: exec-team, engineering) → `memory_recall("Q3 전략")`
2. 주니어 엔지니어 (groups: engineering) → `memory_recall("Q3 전략")`
3. CEO: 이사회 결정 + 엔지니어링 로드맵 + 재무 데이터 반환
4. 엔지니어: 엔지니어링 로드맵만 반환

**검증 포인트**:
- 같은 쿼리, 다른 결과 — ACL 필터가 정확히 동작
- 성능: ACL 필터링이 검색 속도에 미치는 영향 (JOIN overhead)

---

## Use Case 8: DM 데이터 프라이버시

**Actor**: System
**Flow**:
1. Slack DM (alice ↔ bob) sync
2. 시스템이 `slack:dm:alice-bob` 그룹 자동 생성 (2명만 멤버)
3. charlie가 `memory_recall("alice bob 대화")` → 결과 없음
4. alice가 검색하면 해당 DM 내용 반환

**검증 포인트**:
- DM 그룹은 자동 생성, 수동 수정 불가
- DM 멤버가 아닌 admin도 접근 불가? → **결정 필요**

---

## 미결정 사항 (리뷰에서 결정 필요)

1. **admin 전체 접근**: admin이 모든 private entity에 접근 가능한가?
2. **required_groups vs acl_members 우선순위**: 둘 다 있으면 OR? AND?
3. **그룹 admin 위임**: 그룹별 admin이 있는가, 전체 admin만 관리하는가?
4. **DM 프라이버시**: admin도 DM에 접근 못하는가?
5. **퇴사자 데이터**: orphaned private entity는 어떻게 처리?
