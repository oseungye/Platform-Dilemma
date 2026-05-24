/* =============================================================================
   플랫폼 노동 정책 시뮬레이터 — script.js
   -----------------------------------------------------------------------------
   구성
     [A] 데이터 정의 : 지표 메타 / 역할 / 정책 카드 / 이벤트 카드 / 엔딩
     [B] 상태 관리   : STATE 객체 + localStorage 저장·복원
     [C] 게임 엔진   : 효과 적용 · 연쇄(cascade) 계산 · 턴 진행
     [D] 렌더링      : 화면 전환 · 대시보드 · 정책/이벤트 카드 · 사이드 패널
     [E] 결과 분석   : 역할 달성도 · 엔딩 분류 · 보고서 텍스트/차트 생성
     [F] 초기화      : 이벤트 바인딩 · 부팅
   -----------------------------------------------------------------------------
   핵심 설계 원칙
     · 모든 지표는 0~100. 어떤 선택도 "전부 좋은" 결과를 주지 않는다(상충).
     · 정책 직접효과 → 이벤트 → 연쇄효과(구조 변수의 파급)가 매 턴 누적된다.
     · 인건비·자동화는 '구조 변수'로, 표면 지표를 서서히 끌고 가는 숨은 동력이다.
   ============================================================================= */

'use strict';

/* =============================================================================
   [A] 데이터 정의
   ============================================================================= */

/* ---- A-1. 지표 메타데이터 -------------------------------------------------
   polarity: 'high' = 높을수록 바람직, 'low' = 낮을수록 바람직(실업률·갈등)
   start   : 기본 시작값 (역할에 따라 startTweak로 미세 조정됨)            */
const INDICATORS = [
  { key: 'worker',    code: 'IDX-01', name: '노동자 만족도',     polarity: 'high', start: 55 },
  { key: 'profit',    code: 'IDX-02', name: '기업 수익성',       polarity: 'high', start: 60 },
  { key: 'gig',       code: 'IDX-03', name: '플랫폼 노동 증가율', polarity: 'high', start: 50 },
  { key: 'stability', code: 'IDX-04', name: '사회 안정성',       polarity: 'high', start: 60 },
  { key: 'unemploy',  code: 'IDX-05', name: '실업률',           polarity: 'low',  start: 35 },
  { key: 'consumer',  code: 'IDX-06', name: '소비자 편의성',     polarity: 'high', start: 62 },
  { key: 'finance',   code: 'IDX-07', name: '국가 재정',         polarity: 'high', start: 55 },
  { key: 'conflict',  code: 'IDX-08', name: '사회적 갈등 지수',   polarity: 'low',  start: 35 },
];
const INDICATOR_MAP = Object.fromEntries(INDICATORS.map(i => [i.key, i]));

/* ---- A-2. 역할(이해관계자) -------------------------------------------------
   mult       : 정책 직접효과에 곱해지는 역할별 가중치(영향력 차이)
   startTweak : 시작 지표 보정(초기 조건 차이)
   weights    : 결과 평가(역할 목표 달성도) 계산에 쓰는 가중치(합 1 정규화)   */
const ROLES = {
  gov: {
    code: 'GOV', name: '정부', en: 'THE STATE',
    tagline: '사회 전체의 지속가능성을 책임진다',
    desc: '특정 집단이 아니라 사회 전체를 본다. 안정과 형평, 그리고 재정의 한계 사이에서 줄타기를 한다.',
    goal: '사회 안정성·낮은 갈등·재정 건전성의 균형',
    constraint: '재정 적자와 여론(갈등)에 동시에 묶인다',
    power: '정책 영향력은 넓지만, 재정 충격은 완화(–15%)',
    mult: { finance: 0.85 },
    startTweak: { finance: 8 },
    weights: { stability: 28, conflict: 22, finance: 18, worker: 12, unemploy: 12, profit: 8 },
  },
  firm: {
    code: 'PLT', name: '플랫폼 기업', en: 'THE PLATFORM',
    tagline: '성장과 수익으로 존재를 증명한다',
    desc: '효율과 확장이 곧 생존이다. 그러나 평판이 무너지면 성장 동력도 함께 꺼진다.',
    goal: '기업 수익성·플랫폼 성장·소비자 편익 극대화',
    constraint: '사회적 갈등(평판)이 높아지면 성장도 멈춘다',
    power: '수익·성장에 미치는 영향 확대(+25%/+15%)',
    mult: { profit: 1.25, gig: 1.15 },
    startTweak: { profit: 8, finance: -6 },
    weights: { profit: 34, gig: 22, consumer: 20, conflict: 12, worker: 12 },
  },
  worker: {
    code: 'LAB', name: '노동자 대표', en: 'THE LABOR',
    tagline: '사람의 삶을 숫자 위에 놓는다',
    desc: '노동자의 소득과 안정을 지킨다. 하지만 기업이 무너지면 지킬 일자리도 사라진다는 역설을 안고 있다.',
    goal: '노동자 만족도·고용 안정·낮은 갈등',
    constraint: '기업 수익이 붕괴하면 일자리도 사라진다',
    power: '노동·갈등 변수에 미치는 영향 확대(+25%/+15%)',
    mult: { worker: 1.25, conflict: 1.15 },
    startTweak: { worker: 6, profit: -4 },
    weights: { worker: 34, conflict: 20, unemploy: 18, stability: 16, profit: 12 },
  },
};

/* ---- A-3. 정책 카드 풀 -----------------------------------------------------
   lean   : 정책 성향  welfare(복지/노동보호) · market(시장/효율) · state(국가/재정) · consensus(사회통합)
   effects: 8개 지표에 대한 직접 변화량
   struct : 구조 변수(인건비 laborCost, 자동화 automation) 변화량
   dilemma: 반드시 함께 드러나는 '대가' (단순 선악화를 방지)                  */
const POLICIES = [
  { id:'P01', cat:'소득보장', lean:'welfare', title:'플랫폼 노동자 최소소득 보장제',
    desc:'배차·호출 건수와 무관하게 일정 수준의 월 소득을 법으로 보장한다.',
    effects:{ worker:14, stability:8, conflict:-7, profit:-9, finance:-8, consumer:-3, unemploy:3 },
    struct:{ laborCost:14 },
    dilemma:'인건비가 급등해 기업 수익과 일부 고용이 흔들린다' },

  { id:'P02', cat:'안전망', lean:'state', title:'국가 지원형 소득 안전망',
    desc:'기업이 아닌 국가 재정으로 소득 하한을 메우는 보편적 안전망을 구축한다.',
    effects:{ worker:10, stability:9, conflict:-6, finance:-14, unemploy:-2, profit:1 },
    struct:{ laborCost:3 },
    dilemma:'국가 재정 부담이 커 지속가능성이 관건이다' },

  { id:'P03', cat:'책임분담', lean:'welfare', title:'기업 공동 부담제',
    desc:'플랫폼 기업이 소득 보장 재원을 함께 부담하도록 의무화한다.',
    effects:{ worker:9, stability:5, conflict:-4, profit:-12, finance:4, unemploy:4 },
    struct:{ laborCost:12 },
    dilemma:'비용 전가로 고용 축소·자동화 유인이 커진다' },

  { id:'P04', cat:'투명성', lean:'welfare', title:'알고리즘 배차 투명화',
    desc:'배차·수수료 알고리즘을 공개해 노동자의 예측 가능성을 높인다.',
    effects:{ worker:8, conflict:-5, stability:4, profit:-5, consumer:-2, gig:-1 },
    struct:{ laborCost:3 },
    dilemma:'운영 효율 저하와 영업비밀 논란이 따른다' },

  { id:'P05', cat:'규제완화', lean:'market', title:'플랫폼 규제 완화',
    desc:'진입·운영 규제를 풀어 플랫폼의 성장과 소비자 편익을 키운다.',
    effects:{ profit:12, gig:10, consumer:8, worker:-8, conflict:6, stability:-4, unemploy:-3 },
    struct:{ laborCost:-6 },
    dilemma:'노동 보호 후퇴로 불안정 노동이 확대된다' },

  { id:'P06', cat:'기술투자', lean:'market', title:'자동화 투자 지원',
    desc:'배달 로봇·자동 배차 등 자동화에 세제·금융을 지원한다.',
    effects:{ profit:9, consumer:6, gig:-4, unemploy:8, worker:-5, conflict:4 },
    struct:{ automation:12 },
    dilemma:'일자리 대체로 실업과 갈등의 씨앗을 키운다' },

  { id:'P07', cat:'수수료', lean:'welfare', title:'플랫폼 수수료 인하 유도',
    desc:'과도한 중개 수수료를 제한해 노동자 실수령액을 높인다.',
    effects:{ worker:7, gig:5, profit:-8, consumer:3, conflict:-2 },
    struct:{ laborCost:2 },
    dilemma:'기업 수익성을 직접 압박한다' },

  { id:'P08', cat:'노동권', lean:'welfare', title:'노동자 단체교섭권 보장',
    desc:'플랫폼 노동자에게 단결·교섭권을 부여한다.',
    effects:{ worker:11, conflict:-5, stability:4, profit:-7, gig:-3 },
    struct:{ laborCost:9 },
    dilemma:'초기 교섭 과정에서 갈등과 비용이 상승한다' },

  { id:'P09', cat:'고용전환', lean:'state', title:'직업 재교육·전직 지원',
    desc:'자동화로 밀려난 노동자를 위한 재교육과 전직을 지원한다.',
    effects:{ unemploy:-8, worker:5, stability:5, finance:-9, profit:2, conflict:-3 },
    struct:{ automation:2 },
    dilemma:'효과는 더디고 재정 지출은 즉시 발생한다' },

  { id:'P10', cat:'사회보험', lean:'welfare', title:'플랫폼 노동 4대보험 적용',
    desc:'산재·고용·건강·연금 보험을 플랫폼 노동에 확대한다.',
    effects:{ worker:12, stability:6, conflict:-5, profit:-10, gig:-4, unemploy:3 },
    struct:{ laborCost:13 },
    dilemma:'사각지대는 줄지만 고용주 부담이 급증한다' },

  { id:'P11', cat:'경쟁촉진', lean:'market', title:'신규 플랫폼 진입 지원',
    desc:'독과점을 견제하고 새 플랫폼의 시장 진입을 돕는다.',
    effects:{ gig:9, consumer:7, profit:4, worker:2, finance:-5 },
    struct:{ automation:1 },
    dilemma:'시장 과열과 노동의 분산·파편화가 우려된다' },

  { id:'P12', cat:'소비자', lean:'state', title:'소비자 보호·가격 규제',
    desc:'급격한 가격 인상과 불공정 약관으로부터 소비자를 보호한다.',
    effects:{ consumer:9, conflict:-2, profit:-7, gig:-3, worker:1 },
    struct:{ laborCost:1 },
    dilemma:'가격 통제는 공급 위축을 부를 수 있다' },

  { id:'P13', cat:'재정', lean:'market', title:'긴축 재정·복지 축소',
    desc:'재정 건전성을 위해 복지 지출과 보조금을 줄인다.',
    effects:{ finance:13, profit:3, worker:-9, stability:-6, conflict:7, unemploy:5 },
    struct:{ laborCost:-4 },
    dilemma:'재정은 살아나지만 사회 안전망이 무너진다' },

  { id:'P14', cat:'사회통합', lean:'consensus', title:'사회적 대화기구 설치',
    desc:'노·사·정이 함께 의제를 조율하는 상설 협의체를 만든다.',
    effects:{ conflict:-9, stability:8, worker:5, profit:-2, finance:-3 },
    struct:{ laborCost:1 },
    dilemma:'합의는 더디고 구속력이 약하다' },

  { id:'P15', cat:'조세', lean:'state', title:'플랫폼세 도입',
    desc:'플랫폼 매출에 과세해 재원을 마련하고 재분배한다.',
    effects:{ finance:12, profit:-9, worker:3, conflict:-2, consumer:-2, gig:-3 },
    struct:{ laborCost:2 },
    dilemma:'세 부담이 기업·소비자에게 전가될 수 있다' },

  { id:'P16', cat:'임금', lean:'welfare', title:'플랫폼 최저보수 대폭 인상',
    desc:'건당·시간당 최저 보수 기준을 큰 폭으로 끌어올린다.',
    effects:{ worker:13, stability:5, conflict:-4, profit:-11, unemploy:7, consumer:-4 },
    struct:{ laborCost:16 },
    dilemma:'소득은 오르지만 고용은 줄어들 수 있다' },
];
const POLICY_MAP = Object.fromEntries(POLICIES.map(p => [p.id, p]));
const LEAN_LABEL = { welfare:'복지·노동', market:'시장·효율', state:'국가·재정', consensus:'사회통합' };

/* ---- A-4. 이벤트 카드 풀 ---------------------------------------------------
   매 턴 시작 시 확률적으로 1장 발생하여 즉시 지표에 반영된다.
   E00은 '특이사항 없음'(평온한 분기).                                        */
const EVENTS = [
  { id:'E01', name:'배달 노동자 총파업', desc:'열악한 처우에 항의하는 대규모 파업이 도시를 멈춰 세운다.',
    effects:{ stability:-6, conflict:9, consumer:-5, profit:-5, worker:3 } },
  { id:'E02', name:'경기 침체 진입', desc:'소비 위축과 함께 플랫폼 주문량이 급감한다.',
    effects:{ profit:-10, unemploy:9, finance:-6, consumer:-4, conflict:4 } },
  { id:'E03', name:'AI 자동화 급가속', desc:'배차·물류 자동화가 예상보다 빠르게 인력을 대체한다.',
    effects:{ profit:7, unemploy:8, worker:-5, gig:-6, consumer:4 }, struct:{ automation:8 } },
  { id:'E04', name:'플랫폼 독점 논란', desc:'한 기업의 시장 지배가 공정성 시비를 일으킨다.',
    effects:{ conflict:6, consumer:-5, profit:4, worker:-3, stability:-3 } },
  { id:'E05', name:'청년 실업 급증', desc:'양질의 일자리가 줄며 청년층이 플랫폼으로 몰린다.',
    effects:{ unemploy:10, conflict:5, stability:-4, worker:-3 } },
  { id:'E06', name:'소비자 불만 폭증', desc:'배달 지연·요금 인상에 대한 항의가 빗발친다.',
    effects:{ consumer:-9, profit:-5, conflict:3 } },
  { id:'E07', name:'사회적 대타협 시도', desc:'노·사·정이 한자리에 모여 양보를 교환한다.',
    effects:{ conflict:-8, stability:7, worker:4, profit:2 } },
  { id:'E08', name:'배달 중 대형 사고', desc:'한 노동자의 사망 사고가 안전 책임 논쟁을 점화한다.',
    effects:{ conflict:9, stability:-6, worker:-4, profit:-4 } },
  { id:'E09', name:'플랫폼 투자 호황', desc:'대규모 투자가 유입되며 시장이 빠르게 팽창한다.',
    effects:{ profit:9, gig:7, consumer:5, unemploy:-5, finance:4 } },
  { id:'E10', name:'글로벌 경쟁 심화', desc:'해외 플랫폼의 진입으로 단가 경쟁이 격화된다.',
    effects:{ profit:-6, gig:4, worker:-3, consumer:3 } },
  { id:'E00', name:'특이사항 없는 분기', desc:'큰 충격 없이 지표가 구조적 흐름을 따라 움직인다.',
    effects:{} },
];
const EVENT_MAP = Object.fromEntries(EVENTS.map(e => [e.id, e]));

/* ---- A-5. 엔딩 정의 --------------------------------------------------------- */
const ENDINGS = {
  welfare:   { title:'복지 확대형 사회',       sub:'사람을 먼저 지킨 사회, 그러나 비용을 누가 감당하는가',
               verdict:'복지·안정 우위' },
  efficient: { title:'고효율 플랫폼 경제',     sub:'성장과 편익은 최고조, 노동의 안정은 후순위로',
               verdict:'효율·성장 우위' },
  corporate: { title:'기업 중심 성장 모델',     sub:'시장은 번영하지만 그늘은 깊어졌다',
               verdict:'자본 우위·격차 확대' },
  conflict:  { title:'사회 갈등 심화형',       sub:'균형을 잃은 사회, 신뢰가 무너졌다',
               verdict:'통합 실패' },
  balance:   { title:'균형적 타협 모델',       sub:'완벽하지 않지만, 누구도 절멸시키지 않은 사회',
               verdict:'지속가능한 균형' },
};

/* 게임 설정 */
const TOTAL_TURNS = 8;
const SAVE_KEY = 'plps_save_v1';

/* =============================================================================
   [B] 상태 관리
   ============================================================================= */
let STATE = null;          // 현재 게임 상태
let chartRefs = [];        // 보고서 차트 인스턴스(재시작 시 파기용)

/** 새 게임 상태 생성 */
function createState(roleKey) {
  const role = ROLES[roleKey];
  const ind = {};
  INDICATORS.forEach(i => { ind[i.key] = i.start; });
  // 역할별 시작 보정
  for (const [k, v] of Object.entries(role.startTweak || {})) ind[k] = clamp(ind[k] + v);

  return {
    role: roleKey,
    turn: 1,
    indicators: ind,
    structure: { laborCost: 50, automation: 40 }, // 구조 변수
    history: [ snapshot(ind) ],   // 턴별 지표 기록(0턴=시작)
    chosen: [],                   // 선택한 정책 id 목록
    leanCount: { welfare:0, market:0, state:0, consensus:0 },
    log: [],                      // 의사결정 로그
    pendingEvent: null,           // 이번 턴 이벤트 id (이미 적용됨)
    pendingPolicies: [],          // 이번 턴 제시된 정책 id 3장
    finished: false,
  };
}

/** 지표 스냅샷(얕은 복사) */
function snapshot(ind) { return Object.assign({}, ind); }

/** localStorage 저장 */
function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(STATE)); } catch (e) {}
}
/** localStorage 불러오기 */
function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }

/* =============================================================================
   [C] 게임 엔진
   ============================================================================= */

/** 0~100 범위로 가두기 */
function clamp(v, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, v)); }

/** 정책/이벤트의 effects를 지표에 적용. mult는 역할 가중치(정책에만 사용) */
function applyEffects(effects, mult) {
  for (const [k, raw] of Object.entries(effects || {})) {
    const m = (mult && mult[k]) ? mult[k] : 1;
    STATE.indicators[k] = clamp(STATE.indicators[k] + raw * m);
  }
}

/** 구조 변수(인건비/자동화) 적용 */
function applyStruct(struct) {
  for (const [k, v] of Object.entries(struct || {})) {
    STATE.structure[k] = clamp(STATE.structure[k] + v);
  }
}

/* ---- C-1. 연쇄효과(Cascade) ------------------------------------------------
   정책의 '직접효과' 이후, 구조 변수와 임계치가 지표를 추가로 끌어당긴다.
   → "인건비 증가 = 무조건 악", "복지 = 무조건 선"이라는 단순화를 막는 장치.
   모든 델타는 현재값 스냅샷에서 한 번에 계산해 적용한다.                    */
function applyCascades() {
  const v = STATE.indicators;
  const s = STATE.structure;
  const d = {}; // 지표별 누적 델타
  const add = (k, x) => { d[k] = (d[k] || 0) + x; };

  // (1) 인건비 파급: 비용↑ → 수익↓·가격↑(소비자↓) / 그러나 노동자↑·안정↑, 기업은 자동화로 대응
  const lc = s.laborCost - 50;
  add('profit',   -lc * 0.15);
  add('consumer', -lc * 0.08);
  add('worker',    lc * 0.10);
  add('stability', lc * 0.05);
  if (lc > 0) s.automation = clamp(s.automation + lc * 0.06); // 비용 압박 → 자동화 유인

  // (2) 자동화 파급: 효율↑(수익·소비자) / 그러나 일자리 대체(실업↑·플랫폼노동↓·노동자↓)
  const au = s.automation - 40;
  add('profit',    au * 0.08);
  add('consumer',  au * 0.05);
  add('unemploy',  au * 0.10);
  add('gig',      -au * 0.07);
  add('worker',   -au * 0.04);

  // (3) 임계치 피드백 루프 (사회 시스템의 비선형 반응)
  if (v.worker   < 35) { add('conflict', 4);  add('stability', -3); } // 불만 누적 → 갈등 폭발
  if (v.profit   < 35) { add('unemploy', 3);  add('gig', -2); }       // 기업 위기 → 고용 위축
  if (v.finance  < 25) { add('stability', -3); }                       // 재정 고갈 → 안정 훼손
  if (v.unemploy > 65) { add('conflict', 3);  add('worker', -2); }     // 대량 실업 → 사회 불안
  if (v.conflict > 65) { add('stability', -4); }                       // 갈등 과열 → 통합 붕괴
  if (v.stability> 72 && v.conflict < 35) { add('worker', 1); add('profit', 1); } // 선순환

  // 한 번에 적용
  for (const [k, x] of Object.entries(d)) STATE.indicators[k] = clamp(STATE.indicators[k] + x);
}

/** 파생 지표: 플랫폼 서비스 가격(인건비↑·자동화↓일수록 상승) */
function platformPrice() {
  const s = STATE.structure;
  return clamp(Math.round(50 + (s.laborCost - 50) * 0.55 - (s.automation - 40) * 0.35));
}

/* ---- C-2. 정책 카드 추첨 ---------------------------------------------------
   - 이미 선택한 정책은 제외
   - 가능하면 복지·시장 성향을 한 장씩 섞어 '상충 선택'을 보장
   - 3턴까지 최소소득보장(P01)이 한 번도 안 나왔다면 강제 편성(핵심 주제)     */
function drawPolicies() {
  const pool = POLICIES.filter(p => !STATE.chosen.includes(p.id));
  const shuffled = shuffle(pool.slice());
  let pick = [];

  // 핵심 주제 보장
  const seenP01 = STATE.chosen.includes('P01') || STATE._offeredP01;
  if (STATE.turn >= 3 && !seenP01) {
    const p01 = shuffled.find(p => p.id === 'P01');
    if (p01) pick.push(p01);
  }

  // 성향 다양성 확보
  const want = ['welfare', 'market'];
  for (const lean of want) {
    if (pick.length >= 3) break;
    const cand = shuffled.find(p => p.lean === lean && !pick.includes(p));
    if (cand) pick.push(cand);
  }
  // 나머지 무작위 채우기
  for (const p of shuffled) {
    if (pick.length >= 3) break;
    if (!pick.includes(p)) pick.push(p);
  }
  pick = shuffle(pick).slice(0, 3);
  if (pick.some(p => p.id === 'P01')) STATE._offeredP01 = true;
  return pick.map(p => p.id);
}

/** 이벤트 추첨: 75% 확률로 실제 이벤트, 25%는 평온(E00). 1턴은 항상 평온 시작. */
function drawEvent() {
  if (STATE.turn === 1) return 'E00';
  if (Math.random() < 0.25) return 'E00';
  const real = EVENTS.filter(e => e.id !== 'E00');
  return real[Math.floor(Math.random() * real.length)].id;
}

/** Fisher–Yates 셔플 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ---- C-3. 턴 진행 ---------------------------------------------------------- */

/** 새 턴 시작: 이벤트 발생(즉시 적용) → 정책 3장 제시 */
function startTurn() {
  const prev = snapshot(STATE.indicators);

  // 이벤트 추첨 및 즉시 적용
  const evId = drawEvent();
  STATE.pendingEvent = evId;
  const ev = EVENT_MAP[evId];
  applyEffects(ev.effects, null);
  applyStruct(ev.struct);
  if (evId !== 'E00') {
    pushLog('event', `[분기 ${STATE.turn}] 이벤트 — ${ev.name}`);
  }

  // 정책 제시
  STATE.pendingPolicies = drawPolicies();

  save();
  renderSim(prev, /*animateEvent*/ true);
}

/** 정책 선택 처리: 직접효과 → 연쇄효과 → 로그 → 다음 턴/종료 */
function choosePolicy(pid) {
  const prev = snapshot(STATE.indicators);
  const p = POLICY_MAP[pid];
  const role = ROLES[STATE.role];

  applyEffects(p.effects, role.mult); // 역할 가중치 반영
  applyStruct(p.struct);
  applyCascades();                    // 구조·임계치 연쇄

  STATE.chosen.push(pid);
  STATE.leanCount[p.lean]++;
  pushLog('policy', `[분기 ${STATE.turn}] 정책 — ${p.title}`);
  STATE.history.push(snapshot(STATE.indicators));

  // 대시보드에 정책+연쇄 결과 애니메이션
  renderDashboard(prev, true);
  renderStruct();
  renderLog();

  if (STATE.turn >= TOTAL_TURNS) {
    STATE.finished = true;
    save();
    setTimeout(endGame, 720); // 마지막 변화 애니메이션을 보여준 뒤 전환
  } else {
    STATE.turn++;
    save();
    setTimeout(startTurn, 720);
  }
}

/** 로그 추가 */
function pushLog(type, text) {
  STATE.log.unshift({ type, text, turn: STATE.turn });
  if (STATE.log.length > 40) STATE.log.pop();
}

/* =============================================================================
   [D] 렌더링
   ============================================================================= */
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/** 화면 전환 */
function showScreen(id) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $('#' + id).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---- D-1. 역할 선택 화면 --------------------------------------------------- */
function renderRoles() {
  const grid = $('#role-grid');
  grid.innerHTML = Object.entries(ROLES).map(([key, r]) => `
    <button class="role-card" data-role="${key}">
      <div class="tag">STAKEHOLDER · ${r.code}</div>
      <h3>${r.name}</h3>
      <div class="role-en">${r.en}</div>
      <p class="desc">${r.desc}</p>
      <div class="role-meta">
        <div><span class="lbl">우선목표</span><span class="val">${r.goal}</span></div>
        <div><span class="lbl">제약조건</span><span class="val">${r.constraint}</span></div>
        <div><span class="lbl">영향력</span><span class="val">${r.power}</span></div>
      </div>
    </button>
  `).join('');

  $$('.role-card').forEach(card => {
    card.addEventListener('click', () => {
      const roleKey = card.dataset.role;
      STATE = createState(roleKey);
      save();
      enterSim();
    });
  });
}

/* ---- D-2. 시뮬레이션 화면 진입 --------------------------------------------- */
function enterSim() {
  const r = ROLES[STATE.role];
  $('#sim-role-code').textContent = r.code;
  $('#sim-role-name').textContent = r.name;
  $('#mast-status').textContent = `${r.name} · 진행 중`;
  showScreen('screen-sim');
  startTurn();
}

/** 시뮬레이션 화면 전체 렌더 (턴 시작 시) */
function renderSim(prev, animateEvent) {
  $('#sim-turn-label').textContent = `TURN ${STATE.turn} / ${TOTAL_TURNS}`;
  renderTurnTrack();
  renderDashboard(prev, animateEvent);
  renderEvent();
  renderPolicies();
  renderStruct();
  renderLog();
}

/** 턴 진행 점 */
function renderTurnTrack() {
  const track = $('#turn-track');
  let html = '';
  for (let t = 1; t <= TOTAL_TURNS; t++) {
    const cls = t < STATE.turn ? 'done' : (t === STATE.turn ? 'current' : '');
    html += `<div class="turn-dot ${cls}">${t}</div>`;
  }
  track.innerHTML = html;
}

/** 지표 대시보드 (prev 대비 델타 표시 + 바 애니메이션) */
function renderDashboard(prev, animate) {
  const wrap = $('#indicators');
  wrap.innerHTML = INDICATORS.map(meta => {
    const v = Math.round(STATE.indicators[meta.key]);
    const warn = meta.polarity === 'low' ? 'warnpole' : '';
    return `
      <div class="ind ${warn}" data-key="${meta.key}">
        <div class="ind-top">
          <span class="ind-name">${meta.name}</span>
          <span class="ind-code">${meta.code}</span>
        </div>
        <div class="ind-val">${v}<span class="unit">/100</span><span class="delta"></span></div>
        <div class="bar"><i style="width:0%"></i></div>
      </div>`;
  }).join('');

  // 바 애니메이션 + 델타 (다음 프레임에 적용해 transition 발동)
  requestAnimationFrame(() => {
    $$('#indicators .ind').forEach(el => {
      const key = el.dataset.key;
      const meta = INDICATOR_MAP[key];
      const cur = Math.round(STATE.indicators[key]);
      el.querySelector('.bar i').style.width = cur + '%';

      if (prev) {
        const before = Math.round(prev[key]);
        const diff = cur - before;
        if (diff !== 0) {
          // 변화의 '방향'이 바람직한지로 색을 결정(높을수록 좋은 지표 vs 낮을수록 좋은 지표)
          const good = (meta.polarity === 'high' && diff > 0) || (meta.polarity === 'low' && diff < 0);
          const dEl = el.querySelector('.delta');
          dEl.textContent = (diff > 0 ? '+' : '') + diff;
          dEl.classList.add(good ? 'up' : 'down', 'show');
          if (animate) el.classList.add('flash');
        }
      }
    });
  });
}

/** 이벤트 배너 */
function renderEvent() {
  const slot = $('#event-slot');
  const ev = EVENT_MAP[STATE.pendingEvent];
  if (!ev || ev.id === 'E00') {
    slot.innerHTML = `
      <div class="event-banner" style="border-left-color:var(--mint-500)">
        <span class="ev-icon" style="color:var(--mint-400);border-color:rgba(70,199,175,.5)">분기 ${STATE.turn}</span>
        <div><h4>특이사항 없는 분기</h4>
        <p>외부 충격 없이, 지난 선택이 만든 구조적 흐름이 지표를 천천히 움직입니다.</p></div>
      </div>`;
    return;
  }
  slot.innerHTML = `
    <div class="event-banner">
      <span class="ev-icon">EVENT · 분기 ${STATE.turn}</span>
      <div>
        <h4>${ev.name}</h4>
        <p>${ev.desc}</p>
        <div class="ev-eff">${effectChips(ev.effects)}</div>
      </div>
    </div>`;
}

/** 정책 카드 3장 */
function renderPolicies() {
  const grid = $('#policy-grid');
  grid.innerHTML = STATE.pendingPolicies.map(pid => {
    const p = POLICY_MAP[pid];
    return `
      <div class="policy-card" data-pid="${p.id}">
        <span class="lean ${p.lean}">${LEAN_LABEL[p.lean]}</span>
        <span class="cat">${p.cat}</span>
        <h4>${p.title}</h4>
        <p class="pdesc">${p.desc}</p>
        <div class="dilemma">상충: ${p.dilemma}</div>
        <div class="effects">${effectChips(p.effects, p.struct)}</div>
        <button class="pick" data-pid="${p.id}">이 정책 추진</button>
      </div>`;
  }).join('');

  $$('.policy-card .pick').forEach(btn => {
    btn.addEventListener('click', () => {
      // 중복 클릭 방지
      $$('.policy-card .pick').forEach(b => { b.disabled = true; b.style.opacity = .5; });
      choosePolicy(btn.dataset.pid);
    });
  });
}

/** effects/struct → +/- 칩 HTML */
function effectChips(effects, struct) {
  const chips = [];
  for (const [k, v] of Object.entries(effects || {})) {
    if (!v) continue;
    const meta = INDICATOR_MAP[k];
    if (!meta) continue;
    // 표시 색: 바람직한 방향이면 pos
    const good = (meta.polarity === 'high' && v > 0) || (meta.polarity === 'low' && v < 0);
    chips.push(`<span class="chip ${good ? 'pos' : 'neg'}">${meta.name} ${v > 0 ? '+' : ''}${v}</span>`);
  }
  for (const [k, v] of Object.entries(struct || {})) {
    if (!v) continue;
    const label = k === 'laborCost' ? '인건비' : '자동화';
    chips.push(`<span class="chip ${v > 0 ? 'neg' : 'pos'}">${label} ${v > 0 ? '+' : ''}${v}</span>`);
  }
  return chips.join('');
}

/** 구조 지표 패널 */
function renderStruct() {
  const s = STATE.structure;
  const price = platformPrice();
  const rows = [
    { label: '인건비 지수', val: Math.round(s.laborCost), hot: s.laborCost > 62, cool: s.laborCost < 42 },
    { label: '자동화 수준', val: Math.round(s.automation), hot: s.automation > 62, cool: false },
    { label: '플랫폼 서비스 가격', val: price, hot: price > 62, cool: price < 42 },
  ];
  $('#struct-panel').innerHTML = rows.map(r => `
    <div class="struct-row">
      <span class="sl">${r.label}</span>
      <span class="sv ${r.hot ? 'hot' : (r.cool ? 'cool' : '')}">${r.val}</span>
    </div>`).join('') +
    `<div class="struct-row"><span class="sl" style="font-size:11px;color:var(--muted-2)">표면 지표를 끌고 가는 숨은 동력입니다</span></div>`;
}

/** 의사결정 로그 */
function renderLog() {
  $('#log').innerHTML = STATE.log.map(item => `
    <div class="log-item ${item.type}">
      <span class="lt">${item.type === 'policy' ? '정책' : '이벤트'}</span><br />
      ${item.text}
    </div>`).join('') || `<div class="log-item">아직 기록이 없습니다.</div>`;
}

/* =============================================================================
   [E] 결과 분석 & 보고서
   ============================================================================= */

/** 지표를 '바람직함' 기준으로 정규화(낮을수록 좋은 지표는 반전) */
function adjusted(key, value) {
  return INDICATOR_MAP[key].polarity === 'low' ? (100 - value) : value;
}

/** 역할 목표 달성도(0~100) */
function roleScore() {
  const w = ROLES[STATE.role].weights;
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  let s = 0;
  for (const [k, weight] of Object.entries(w)) {
    s += (weight / total) * adjusted(k, STATE.indicators[k]);
  }
  return Math.round(s);
}

/** 엔딩 분류 → 5개 중 하나 반환 */
function classifyEnding(v) {
  const welfare = (v.worker + v.stability + (100 - v.conflict)) / 3;
  const market  = (v.profit + v.gig + v.consumer) / 3;
  const adj = [v.worker, v.profit, v.gig, v.stability, 100 - v.unemploy, v.consumer, v.finance, 100 - v.conflict];
  const mean = adj.reduce((a, b) => a + b, 0) / adj.length;
  const spread = Math.sqrt(adj.reduce((a, b) => a + (b - mean) ** 2, 0) / adj.length);

  if (v.conflict >= 60 || v.stability <= 42) return 'conflict';
  if (welfare >= 60 && v.profit < 58 && v.worker >= 58) return 'welfare';
  if (market >= 60 && v.worker < 52) return (v.conflict >= 48 || v.worker < 44) ? 'corporate' : 'efficient';
  if (spread <= 12 && v.stability >= 52 && v.conflict <= 50) return 'balance';
  if (welfare - market >= 8) return 'welfare';
  if (market - welfare >= 8) return v.conflict >= 48 ? 'corporate' : 'efficient';
  return 'balance';
}

/** 가장 우세한 정책 성향 */
function dominantLean() {
  const entries = Object.entries(STATE.leanCount).sort((a, b) => b[1] - a[1]);
  return entries[0][1] > 0 ? entries[0][0] : 'balance';
}

/** 게임 종료 → 보고서 화면 */
function endGame() {
  $('#mast-status').textContent = `${ROLES[STATE.role].name} · 분석 완료`;
  buildReport();
  showScreen('screen-report');
}

/* ---- E-1. 보고서 생성 ------------------------------------------------------ */
function buildReport() {
  const v = STATE.indicators;
  const start = STATE.history[0];
  const role = ROLES[STATE.role];
  const endingKey = classifyEnding(v);
  const ending = ENDINGS[endingKey];
  const score = roleScore();
  const lean = dominantLean();

  // 변화량 계산 및 정렬
  const changes = INDICATORS.map(m => ({
    meta: m,
    start: Math.round(start[m.key]),
    end: Math.round(v[m.key]),
    diff: Math.round(v[m.key] - start[m.key]),
  }));
  const topChanges = changes.slice().sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 4);
  const biggestUp = changes.slice().sort((a, b) => b.diff - a.diff)[0];
  const biggestDown = changes.slice().sort((a, b) => a.diff - b.diff)[0];

  // 선택 정책 텍스트
  const chosenTitles = STATE.chosen.map(id => POLICY_MAP[id].title);
  const usedMinIncome = STATE.chosen.some(id => ['P01', 'P03', 'P10', 'P16'].includes(id));
  const usedMarket = STATE.chosen.some(id => POLICY_MAP[id].lean === 'market');

  // --- 동적 분석 문장들 ---
  const orientationText = {
    welfare:   '노동 보호와 소득 안정을 최우선에 둔 <span class="hl">복지·노동 중심</span> 경로',
    market:    '성장과 효율, 소비자 편익을 앞세운 <span class="hl">시장·효율 중심</span> 경로',
    state:     '재정과 제도를 통한 <span class="hl">국가 조정 중심</span> 경로',
    consensus: '갈등 완화와 합의를 앞세운 <span class="hl">사회통합 중심</span> 경로',
    balance:   '특정 가치에 치우치지 않은 <span class="hl">절충적</span> 경로',
  }[lean];

  // 핵심 딜레마 단락(실제 수치 인용)
  const dProfit = changes.find(c => c.meta.key === 'profit').diff;
  const dWorker = changes.find(c => c.meta.key === 'worker').diff;
  const dFinance = changes.find(c => c.meta.key === 'finance').diff;
  const dConsumer = changes.find(c => c.meta.key === 'consumer').diff;
  const dUnemp = changes.find(c => c.meta.key === 'unemploy').diff;
  const dConflict = changes.find(c => c.meta.key === 'conflict').diff;

  let dilemmaPara;
  if (usedMinIncome) {
    dilemmaPara = `이번 시뮬레이션의 핵심은 <span class="hl">최소소득 보장·인건비 부담의 상충</span>이었다.
      소득 보장을 강화하는 정책을 택하면서 노동자 만족도는 <span class="hl">${signed(dWorker)}</span> 움직였지만,
      그 비용은 곧바로 기업 수익성(<span class="hl-neg">${signed(dProfit)}</span>)과
      국가 재정(<span class="hl-neg">${signed(dFinance)}</span>)으로 전가되었다.
      인건비 지수는 ${Math.round(STATE.structure.laborCost)}까지 올랐고, 이는 플랫폼 서비스 가격 상승과
      자동화 유인(자동화 수준 ${Math.round(STATE.structure.automation)})으로 이어져 소비자 편의성과 일부 고용에
      압력을 가했다. 즉, "노동자의 삶을 지킨다"는 선의는 <span class="hl-neg">누가 그 비용을 감당하는가</span>라는
      질문을 피할 수 없었다.`;
  } else if (usedMarket) {
    dilemmaPara = `이번 시뮬레이션은 <span class="hl">효율과 안정의 상충</span>을 분명히 드러냈다.
      규제 완화·자동화를 통해 기업 수익성(<span class="hl">${signed(dProfit)}</span>)과 소비자 편의성은
      개선되었으나, 그 대가로 노동자 만족도(<span class="hl-neg">${signed(dWorker)}</span>)와
      실업률(<span class="hl-neg">${signed(dUnemp)}</span>)에서 비용이 발생했다.
      성장의 과실이 노동의 안정과 맞바꾸어졌다는 점에서, 시장 효율은 결코 '공짜'가 아니었다.`;
  } else {
    dilemmaPara = `이번 시뮬레이션은 어느 한쪽으로 치우치기보다 <span class="hl">상충하는 가치들 사이의 조정</span>에
      집중했다. 그 결과 사회적 갈등 지수는 <span class="hl">${signed(dConflict)}</span> 움직였으며,
      극단적 성공도 극단적 실패도 피했다. 다만 모든 것을 만족시키는 선택은 존재하지 않았고,
      균형은 언제나 '덜 나쁜 것'을 고르는 과정이었다.`;
  }

  // 종합 평가(세특 활용 수준의 심화 문장)
  const implicationText = `본 시뮬레이션은 플랫폼 노동의 확산이 단순한 고용 형태의 변화가 아니라,
    <strong>소득 보장·기업 부담·소비자 후생·국가 재정이 서로를 제약하는 구조적 딜레마</strong>임을 드러낸다.
    ${role.name}의 입장에서 ${TOTAL_TURNS}개 분기를 운영한 결과, 사회는 <strong>'${ending.title}'</strong>으로 귀결되었으며
    역할 목표 달성도는 ${score}점으로 평가되었다. 특히 ${biggestUp.meta.name}이(가) 가장 크게 개선(${signed(biggestUp.diff)})된 반면
    ${biggestDown.meta.name}은(는) 가장 크게 악화(${signed(biggestDown.diff)})되었다는 사실은,
    <strong>모든 정책 선택이 누군가의 이득과 누군가의 손실을 동시에 만들어낸다</strong>는 사회과학적 통찰을 보여준다.
    결국 '최소소득 보장'과 '기업의 사회적 책임'은 양립 불가능한 대립항이 아니라,
    <strong>비용의 분담 방식과 그 정당성에 대한 사회적 합의</strong>의 문제임을 시뮬레이션은 시사한다.`;

  // --- HTML 조립 ---
  $('#report-doc').innerHTML = `
    <div class="report-header">
      <div class="docmeta">POLICY SIMULATION REPORT · ${role.code} · ${TOTAL_TURNS} QUARTERS</div>
      <h2>${ending.title}</h2>
      <div class="ending-sub">${ending.sub}</div>
      <div class="verdict">최종 판정 · ${ending.verdict} · 역할 달성도 ${score}점</div>
    </div>

    <div class="report-body">
      <!-- 01 개요 -->
      <section class="report-section">
        <div class="sec-no">SECTION 01</div>
        <h3>정책 운영 개요</h3>
        <p>본 보고서는 <span class="hl">${role.name}</span>의 관점에서 진행된 플랫폼 노동 정책 시뮬레이션의 결과를 분석한다.
          ${TOTAL_TURNS}개 분기 동안 의사결정자는 ${orientationText}를 택했으며,
          성향별 선택 분포는 복지·노동 ${STATE.leanCount.welfare} · 시장·효율 ${STATE.leanCount.market} ·
          국가·재정 ${STATE.leanCount.state} · 사회통합 ${STATE.leanCount.consensus} 건으로 나타났다.</p>
        <p style="font-size:13px;color:var(--muted)">추진 정책: ${chosenTitles.join(' · ')}</p>
      </section>

      <!-- 02 지표 변화 -->
      <section class="report-section">
        <div class="sec-no">SECTION 02</div>
        <h3>사회 지표의 변화</h3>
        <div class="score-grid">
          ${topChanges.map(c => {
            const good = (c.meta.polarity === 'high' && c.diff > 0) || (c.meta.polarity === 'low' && c.diff < 0);
            return `<div class="score-cell">
              <div class="scn">${c.meta.name}</div>
              <div class="scv">${c.end}</div>
              <div class="scd ${good ? 'up' : 'down'}">${c.start} → ${c.end} (${signed(c.diff)})</div>
            </div>`;
          }).join('')}
        </div>
        <div class="chart-box">
          <canvas id="chart-line"></canvas>
          <div class="chart-cap">분기별 주요 지표 추이 — 정책 선택과 외부 이벤트가 누적된 결과</div>
        </div>
      </section>

      <!-- 03 핵심 딜레마 -->
      <section class="report-section">
        <div class="sec-no">SECTION 03</div>
        <h3>핵심 딜레마 — 무엇과 무엇을 맞바꾸었는가</h3>
        <p>${dilemmaPara}</p>
      </section>

      <!-- 04 성향 진단 -->
      <section class="report-section">
        <div class="sec-no">SECTION 04</div>
        <h3>정책 성향 진단 · ${ending.title}</h3>
        <p>${endingNarrative(endingKey, v)}</p>
        <div class="chart-box">
          <canvas id="chart-radar"></canvas>
          <div class="chart-cap">최종 사회 균형 프로파일 — 바깥쪽일수록 바람직(실업률·갈등은 반전 적용)</div>
        </div>
      </section>

      <!-- 05 종합 평가 -->
      <section class="report-section" style="margin-bottom:0">
        <div class="sec-no">SECTION 05</div>
        <h3>종합 평가 및 사회과학적 함의</h3>
        <div class="implication">
          <h4>EXPLORATION INSIGHT</h4>
          <p>${implicationText}</p>
        </div>
      </section>
    </div>`;

  // 차트 렌더 (DOM 삽입 이후)
  renderCharts(start, v);
  clearSave(); // 완료된 게임의 진행 저장은 지움(보고서는 화면에 유지)
}

/** +n / -n 부호 문자열 */
function signed(n) { return (n > 0 ? '+' : '') + n; }

/** 엔딩별 서술 */
function endingNarrative(key, v) {
  const map = {
    welfare: `사회는 노동자의 삶과 안정을 우선했다. 노동자 만족도와 사회 안정성이 높게 유지된 대신,
      기업 수익성(${Math.round(v.profit)})과 재정(${Math.round(v.finance)})은 부담을 떠안았다.
      <span class="hl">분배의 정의</span>를 달성했으나, 그 <span class="hl-neg">비용의 지속가능성</span>이라는 숙제를 남겼다.`,
    efficient: `플랫폼 경제는 효율과 편익의 정점에 올랐다. 기업 수익성과 소비자 편의성은 높지만,
      노동자 만족도(${Math.round(v.worker)})는 상대적으로 낮게 머물렀다. 성장은 빛났으나,
      그 <span class="hl-neg">그늘에 선 노동</span>의 목소리는 작아졌다.`,
    corporate: `자본과 시장이 사회를 주도했다. 수익과 성장은 확보되었으나 노동 만족도가 낮고
      갈등(${Math.round(v.conflict)})이 잔존하는 <span class="hl-neg">격차 확대형</span> 구조가 형성되었다.
      번영의 총량은 컸지만, 그 분배는 고르지 않았다.`,
    conflict: `사회는 균형을 잃었다. 갈등 지수(${Math.round(v.conflict)})가 높고 안정성(${Math.round(v.stability)})이 낮아
      어떤 가치도 안정적으로 지켜지지 못했다. 이는 <span class="hl-neg">상충하는 요구를 조정하지 못했을 때</span>
      사회가 치르는 대가를 보여준다.`,
    balance: `사회는 어느 한쪽도 절멸시키지 않는 <span class="hl">지속가능한 균형</span>에 도달했다.
      화려한 성공은 아니지만, 노동·기업·국가가 각자 일정한 양보를 통해 공존하는 모델이다.
      현실의 정책이 지향하는 '<span class="hl">덜 나쁜 균형</span>'에 가장 가깝다.`,
  };
  return map[key];
}

/* ---- E-2. 차트 ------------------------------------------------------------- */
function renderCharts(start, v) {
  if (!window.Chart) return; // CDN 미로딩 시 안전하게 생략
  Chart.defaults.font.family = "'Pretendard', sans-serif";
  Chart.defaults.color = '#5d6c72';
  chartRefs.forEach(c => c.destroy());
  chartRefs = [];

  // (1) 분기별 추이 — 노동자/기업/안정성/갈등
  const labels = STATE.history.map((_, i) => i === 0 ? '시작' : `${i}분기`);
  const series = [
    { key: 'worker',    label: '노동자 만족도', color: '#1f9e89' },
    { key: 'profit',    label: '기업 수익성',   color: '#1d4b73' },
    { key: 'stability', label: '사회 안정성',   color: '#46c7af' },
    { key: 'conflict',  label: '사회적 갈등',   color: '#cf6b58' },
  ];
  const lineCtx = document.getElementById('chart-line');
  if (lineCtx) {
    chartRefs.push(new Chart(lineCtx, {
      type: 'line',
      data: {
        labels,
        datasets: series.map(s => ({
          label: s.label,
          data: STATE.history.map(h => Math.round(h[s.key])),
          borderColor: s.color,
          backgroundColor: s.color + '22',
          borderWidth: 2.4, tension: .35, pointRadius: 3, pointBackgroundColor: s.color, fill: false,
        })),
      },
      options: {
        responsive: true, animation: { duration: 900 },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } } },
        scales: { y: { min: 0, max: 100, grid: { color: '#e7ebe9' } }, x: { grid: { display: false } } },
      },
    }));
  }

  // (2) 레이더 — 시작 vs 최종 (바람직함 기준)
  const radarCtx = document.getElementById('chart-radar');
  if (radarCtx) {
    const keys = INDICATORS.map(m => m.key);
    chartRefs.push(new Chart(radarCtx, {
      type: 'radar',
      data: {
        labels: INDICATORS.map(m => m.name),
        datasets: [
          { label: '시작 상태', data: keys.map(k => Math.round(adjusted(k, start[k]))),
            borderColor: '#9aa7ad', backgroundColor: 'rgba(154,167,173,.12)', borderWidth: 1.5, pointRadius: 2 },
          { label: '최종 상태', data: keys.map(k => Math.round(adjusted(k, v[k]))),
            borderColor: '#1f9e89', backgroundColor: 'rgba(43,179,154,.18)', borderWidth: 2.4, pointRadius: 3 },
        ],
      },
      options: {
        responsive: true, animation: { duration: 900 },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } } },
        scales: { r: { min: 0, max: 100, ticks: { stepSize: 25, backdropColor: 'transparent', font: { size: 10 } },
          grid: { color: '#e2e7e5' }, angleLines: { color: '#e2e7e5' }, pointLabels: { font: { size: 11 } } } },
      },
    }));
  }
}

/* =============================================================================
   [F] 초기화 & 이벤트 바인딩
   ============================================================================= */
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

function boot() {
  renderRoles();

  // 시작 버튼 → 역할 선택
  $('#btn-start').addEventListener('click', () => {
    clearSave();
    showScreen('screen-role');
  });

  // 이어하기 (저장된 미완료 게임 복원)
  const saved = load();
  if (saved && !saved.finished) {
    $('#btn-resume').style.display = 'inline-flex';
    $('#btn-resume').addEventListener('click', () => {
      STATE = saved;
      const r = ROLES[STATE.role];
      $('#sim-role-code').textContent = r.code;
      $('#sim-role-name').textContent = r.name;
      $('#mast-status').textContent = `${r.name} · 진행 중`;
      showScreen('screen-sim');
      // 저장된 턴 상태 그대로 재구성(이벤트·정책은 저장된 것 사용)
      renderSim(null, false);
      toast('이전 진행을 불러왔습니다');
    });
  }

  // 보고서 액션
  $('#btn-print').addEventListener('click', () => window.print());
  $('#btn-replay').addEventListener('click', () => {
    clearSave();
    STATE = null;
    $('#mast-status').textContent = '대기';
    showScreen('screen-role');
  });
}

document.addEventListener('DOMContentLoaded', boot);
