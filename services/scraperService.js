/**
 * CuePost - Scraper Service
 * ─────────────────────────────────────────────────────────────────
 * 외부 AI 디렉터리 사이트에서 Raw 데이터를 수집하고,
 * Gemini 2.5 Flash API로 정제 후 Supabase에 적재하는 파이프라인
 * ─────────────────────────────────────────────────────────────────
 */
import 'dotenv/config';
import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
import pLimit from 'p-limit';

// ── 환경 변수 ────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY  // RLS 우회를 위해 service role 사용
);

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ── 상수 ────────────────────────────────────────────────────────
const LLM_CONCURRENCY_LIMIT = 1;    // 동시 Gemini API 호출 수 제한 (Rate Limit 제어)
const LLM_REQUEST_DELAY_MS = 7000;
const SCRAPE_DELAY_MS = 7000;       // 요청 간 딜레이 (봇 차단 회피)
const MAX_RETRIES = 3;              // LLM 호출 실패 시 재시도 횟수

/**
 * ── 유틸: 딜레이 ─────────────────────────────────────────────────
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ── 유틸: Exponential Backoff 재시도 래퍼 ────────────────────────
 * LLM API 일시적 오류(503, rate limit) 대응
 *
 * @param {Function} fn       - 재시도할 비동기 함수
 * @param {number}   retries  - 남은 재시도 횟수
 */
async function withRetry(fn, retries = MAX_RETRIES) {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    const backoffMs = (MAX_RETRIES - retries + 1) * 10000; // 2s → 10s, 4s → 20s, 6s → 30s
    console.warn(`[Retry] ${retries}회 남음. ${backoffMs}ms 후 재시도. 에러: ${err.message}`);
    await delay(backoffMs);
    return withRetry(fn, retries - 1);
  }
}


// ════════════════════════════════════════════════════════════════
// STEP 1 │ SCRAPER — Cheerio 기반 정적 HTML 파싱
// ════════════════════════════════════════════════════════════════
/**
 * 왜 Cheerio인가? (vs Puppeteer)
 * ┌──────────────┬───────────────────────────────┬──────────────────────────────┐
 * │              │ Cheerio                        │ Puppeteer                    │
 * ├──────────────┼───────────────────────────────┼──────────────────────────────┤
 * │ 렌더링 방식  │ 서버 사이드 HTML 파싱(정적)   │ 실제 크롬 브라우저 구동(동적)│
 * │ 속도         │ 매우 빠름 (수 ms)             │ 느림 (수 초)                 │
 * │ 메모리       │ 낮음                          │ 높음 (탭당 ~100MB+)          │
 * │ JS 렌더링    │ 불가                          │ 가능 (SPA, lazy-load 대응)   │
 * │ 적합한 사이트│ SSR, 전통적 HTML 사이트       │ React/Vue SPA, 로그인 필요   │
 * └──────────────┴───────────────────────────────┴──────────────────────────────┘
 *
 * ▶ 결론: theresanaiforthat.com, futurepedia.io 같은 SSR 기반 디렉터리는
 *         Cheerio로 충분. JS 렌더링이 필요한 사이트만 Puppeteer로 교체.
 *         하이브리드 전략: scrapeTool()의 strategy 파라미터로 분기 가능.
 */

/**
 * 타깃 사이트 설정 목록
 * ─ 사이트마다 CSS 셀렉터가 달라 selector map 으로 관리 (유지보수 핵심!)
 * ─ 레이아웃 변경 시 이 객체만 수정하면 전체 파이프라인에 반영됨
 */

// 수집할 카테고리 목록
const FUTUREPEDIA_CATEGORIES = [
//  'personal Assistant',
//  'research',
// 'spreadsheets',
//  'translator',
//  'presentations',
//  'video-editing',
  'text-to-video',
//  'prompt-generators',
//  'writingenerators',
//  'copywriting',
//  'storyteller',
];

const MAX_PAGES = 2;

// 카테고리 × 페이지 조합으로 타깃 목록 자동 생성
const SCRAPE_TARGETS = FUTUREPEDIA_CATEGORIES.flatMap((category) =>
  Array.from({ length: MAX_PAGES }, (_, i) => ({
    id: `futurepedia-${category}-p${i + 1}`,
    baseUrl: `https://www.futurepedia.io/ai-tools/${category}?verified=true&sort=popular&page=${i + 1}`,
    strategy: 'puppeteer',
    // selectors 제거
  }))
);

/**
 * 단일 사이트에서 AI 툴 Raw 데이터를 스크래핑
 *
 * @param {object} target - SCRAPE_TARGETS 항목
 * @returns {Array<{name, rawCategory, descriptionEn, sourceUrl}>}
 */
async function scrapeTarget(target) {
  console.log(`[Scraper] ▶ ${target.id} 스크래핑 시작`);
  const results = [];
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36'
    );

    await page.goto(target.baseUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // JS 렌더링 완료 후 실제 클래스명 확인용 디버그
    const html = await page.content();
    //console.log('[Debug] 렌더링된 HTML 앞부분:', html.slice(0, 3000));

    // TODO: 실제 클래스명 확인 후 셀렉터 교체 필요
    const { selectors: sel } = target;
    const items = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('a[href*="/tool/"]')]
        .filter((a) => a.querySelector('p'))
        .map((a) => a.closest('div[class*="rounded"]') || a.closest('div'))
        .filter((el, idx, arr) => arr.indexOf(el) === idx);
    
      return cards.map((card) => {
        const name = card.querySelector('p[class*="font-semibold"]')?.innerText?.trim() || '';
        const allP = [...card.querySelectorAll('p')];
        const descriptionEn = allP.find((p) => !p.className.includes('font-semibold'))?.innerText?.trim() || '';
        const sourceUrl = card.querySelector('a[href*="/tool/"]')?.href || '';
        const rawCategory = card.querySelector('a[href*="/ai-tools/"]')?.innerText?.trim() || '';
        return { name, descriptionEn, sourceUrl, rawCategory };
      }).filter((i) => i.name && i.sourceUrl);
    });
    
    results.push(...items);
    
    console.log(`[Scraper] ✔ ${target.id}: ${results.length}개 수집`);

  } catch (err) {
    console.error(`[Scraper] ✘ ${target.id} 실패:`, err.message);
  } finally {
    if (browser) await browser.close();
  }

  await delay(SCRAPE_DELAY_MS);
  return results;
}


// ════════════════════════════════════════════════════════════════
// STEP 2 │ TRANSFORMATION — Gemini 2.5 Flash LLM 정제
// ════════════════════════════════════════════════════════════════

/**
 * Gemini에게 넘길 스키마 명세 (Prompt Engineering 핵심)
 * ─ 출력 형식을 JSON으로만 강제 → 파싱 실패 방지
 * ─ 카테고리 후보군을 명시 → 할루시네이션 억제
 * ─ 토큰 예산: 설명 입력 ~200 토큰, 출력 ~150 토큰 → 비용 예측 가능
 */
const TRANSFORM_PROMPT_TEMPLATE = (tool) => `
You are a B2B SaaS content specialist for an AI tool directory targeting Korean professionals.

Transform the following raw AI tool data into structured JSON. 
Return ONLY a valid JSON object with NO markdown, NO explanation, NO code fences.

Input:
- name: "${tool.name}"
- original_category: "${tool.rawCategory}"
- description_en: "${tool.descriptionEn}"

Output schema (strict):
{
  "summary_ko": "<2-3 sentence Korean summary of what this tool does and who benefits>",
  "main_category": "<one of: developer | marketer | designer | researcher | writer | sales | hr | finance | general>",
  "tags_ko": ["<Korean sub-tag>", ...],   // 2-4 tags, Korean
  "tags_en": ["<English sub-tag>", ...],  // 2-4 tags, English, lowercase-kebab
  "confidence": <0.0 to 1.0>              // how confident you are in the categorization
}

Rules:
- summary_ko must be natural Korean, not a direct translation
- main_category must be exactly one value from the list above
- confidence below 0.5 means ambiguous tools that need manual review
`;

/**
 * 단일 툴 Raw 데이터를 Gemini API로 정제
 *
 * @param {object} rawTool - { name, rawCategory, descriptionEn, sourceUrl }
 * @returns {object|null}  - 정제된 툴 객체 or null (파싱 실패 시)
 */
async function transformWithLLM(rawTool) {
  await delay(LLM_REQUEST_DELAY_MS);
  return withRetry(async () => {
    const model = genAI.models;

    const response = await model.generateContent({
      model: 'gemini-2.5-flash',
      contents: TRANSFORM_PROMPT_TEMPLATE(rawTool),
      config: {
        temperature: 0.2,     // 낮은 temperature → 일관된 JSON 출력
        maxOutputTokens: 512,
        thinkingConfig: {
          thinkingBudget: 0,  // 정제 작업은 사고 불필요 → 비용/속도 최적화
        },
      },
    });

    const rawText = response.text.trim();

    // JSON 파싱 — LLM이 가끔 ```json ``` 래핑을 추가하는 경우 방어 처리
    const jsonString = rawText.replace(/^```json\n?|\n?```$/g, '').trim();
    const parsed = JSON.parse(jsonString);

    // confidence 임계값 체크 — 낮은 신뢰도는 별도 큐로 분리 (수동 검토용)
    if (parsed.confidence < 0.5) {
      console.warn(`[Transform] ⚠ 낮은 신뢰도(${parsed.confidence}): ${rawTool.name}`);
    }

    return {
      title: rawTool.name,
      category: parsed.main_category,
      tags_ko: parsed.tags_ko, 
      summary_ko: parsed.summary_ko,
      summary_en: rawTool.descriptionEn, 
      tags_en: parsed.tags_en, 
      prompt_ko: null,
      prompt_en: null,
      image_url: null,
    };
  });
}

/**
 * Raw 툴 배열을 병렬 정제 (동시성 제한 적용)
 * p-limit으로 LLM API Rate Limit 초과 방지
 *
 * @param {Array} rawTools
 * @returns {Array} 정제 성공한 툴 배열
 */
async function transformAll(rawTools) {
  const limit = pLimit(LLM_CONCURRENCY_LIMIT);
  const results = await Promise.allSettled(
    rawTools.map((tool) => limit(() => transformWithLLM(tool)))
  );

  const succeeded = [];
  const failed = [];

  results.forEach((result, idx) => {
    if (result.status === 'fulfilled' && result.value) {
      succeeded.push(result.value);
    } else {
      failed.push({ tool: rawTools[idx].name, reason: result.reason?.message });
    }
  });

  if (failed.length > 0) {
    console.error(`[Transform] ✘ ${failed.length}개 실패:`, failed);
    // TODO: failed 항목을 DLQ(Dead Letter Queue) 테이블에 기록
    await logFailedItems(failed);
  }

  console.log(`[Transform] ✔ ${succeeded.length}/${rawTools.length}개 정제 완료`);
  return succeeded;
}


// ════════════════════════════════════════════════════════════════
// STEP 3 │ LOAD — Supabase Upsert (중복 방지 적재)
// ════════════════════════════════════════════════════════════════

/**
 * 정제된 툴 데이터를 Supabase에 Upsert
 * ─ source_url을 unique key로 사용 → 중복 삽입 방지
 * ─ Supabase Upsert는 PostgreSQL의 ON CONFLICT DO UPDATE와 동일
 *
 * DB 스키마 전제조건:
 *   CREATE UNIQUE INDEX tools_source_url_idx ON ai_tools (source_url);
 *
 * @param {Array} tools - 정제된 툴 객체 배열
 */
async function loadToDatabase(tools) {
  if (tools.length === 0) {
    console.log('[Load] 적재할 데이터 없음. 스킵.');
    return;
  }

  const { data, error } = await supabase
    .from('cards')
    .upsert(tools, {
      onConflict: 'title', 
      ignoreDuplicates: false,
    })
    .select('id, title, category'); 

  if (error) {
    console.error('[Load] ✘ Supabase upsert 실패:', error);
    throw error;
  }

  console.log(`[Load] ✔ ${data.length}개 Upsert 완료`);
  return data;
}

/**
 * 실패 항목을 scraper_failed_queue 테이블에 기록 (DLQ 패턴)
 * 추후 수동 재처리 또는 알림 발송에 활용
 */
async function logFailedItems(failedItems) {
  const rows = failedItems.map((item) => ({
    tool_name: item.tool,
    failure_reason: item.reason,
    failed_at: new Date().toISOString(),
    retry_count: 0,
  }));

  const { error } = await supabase.from('scraper_failed_queue').insert(rows);
  if (error) console.error('[DLQ] 실패 로그 기록 오류:', error);
}


// ════════════════════════════════════════════════════════════════
// PIPELINE ORCHESTRATOR — 전체 파이프라인 진입점
// ════════════════════════════════════════════════════════════════

/**
 * CuePost 데이터 수집 파이프라인 전체 실행
 * 스케줄러(batchScheduler.js)에서 이 함수를 호출함
 *
 * @returns {{ scraped, transformed, loaded }}
 */
export async function runScraperPipeline() {
  const startedAt = Date.now();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[Pipeline] 🚀 CuePost Scraper 시작 @ ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(60)}`);

  try {
    // ── STEP 1: 스크래핑 ────────────────────────────────────────
    const allRaw = [];
    for (const target of SCRAPE_TARGETS) {
      const raw = await scrapeTarget(target);
      allRaw.push(...raw);
    }
    console.log(`\n[Pipeline] STEP 1 완료 │ 총 ${allRaw.length}개 Raw 데이터 수집`);

    if (allRaw.length === 0) {
      console.log('[Pipeline] 수집 데이터 없음. 파이프라인 종료.');
      return { scraped: 0, transformed: 0, loaded: 0 };
    }

    // ── STEP 2: LLM 정제 ────────────────────────────────────────
    const transformed = await transformAll(allRaw);
    console.log(`[Pipeline] STEP 2 완료 │ ${transformed.length}개 정제`);

    // ── STEP 3: DB 적재 ─────────────────────────────────────────
    const loaded = await loadToDatabase(transformed);
    console.log(`[Pipeline] STEP 3 완료 │ ${loaded?.length ?? 0}개 적재`);

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`\n[Pipeline] ✅ 완료 │ 소요시간: ${elapsed}s`);
    console.log(`${'═'.repeat(60)}\n`);

    return {
      scraped: allRaw.length,
      transformed: transformed.length,
      loaded: loaded?.length ?? 0,
    };
  } catch (err) {
    console.error(`[Pipeline] 💥 치명적 오류:`, err);
    // 운영 알림 (예: Slack Webhook, 이메일)
    await notifyOnFailure(err);
    throw err;
  }
}

/**
 * 파이프라인 치명 오류 시 운영 알림 발송
 * 실제 운영 시 Slack Incoming Webhook / Discord / PagerDuty로 교체
 */
async function notifyOnFailure(err) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `🚨 *CuePost Scraper 파이프라인 오류*\n\`\`\`${err.message}\`\`\``,
    }),
  }).catch(() => {}); // 알림 실패가 파이프라인 에러를 덮지 않도록
}