/**
 * CuePost - Batch Scheduler
 * ─────────────────────────────────────────────────────────────────
 * node-cron으로 scraperPipeline을 매일 새벽 2시에 자동 실행
 * Express 앱 기동 시 함께 등록됨 (app.js에서 import)
 * ─────────────────────────────────────────────────────────────────
 */

import cron from 'node-cron';
import { runScraperPipeline } from './scraperService.js'; 

let isRunning = false; // 동시 실행 방지 플래그

/**
 * 스케줄러 등록 및 즉시 실행 옵션
 * @param {boolean} runImmediately - true이면 서버 시작 시 즉시 1회 실행 (개발/테스트용)
 */
export function initScheduler(runImmediately = false) {
  
  // ── 1. 정기 스케줄 등록 (매일 새벽 2시) ─────────────────────────
  cron.schedule(
    '0 2 * * *',
    async () => {
      if (isRunning) {
        console.warn('[Scheduler] ⚠ 이전 파이프라인이 아직 실행 중. 이번 주기 스킵.');
        return;
      }

      isRunning = true;
      try {
        console.log('[Scheduler] ⏰ 정기 크론 작업 시작...');
        const stats = await runScraperPipeline();
        console.log('[Scheduler] 정기 실행 결과:', stats);
      } catch (err) {
        console.error('[Scheduler] 정기 실행 오류:', err.message);
      } finally {
        isRunning = false;
      }
    },
    {
      timezone: 'Asia/Seoul', // KST 기준으로 스케줄 해석
    }
  );

  console.log('[Scheduler] ✔ Cron 등록 완료 — 매일 KST 02:00 실행 예정');

  // ── 2. 개발/테스트용 즉시 실행 ──────────────────────────────────
  if (runImmediately) {
    console.log('[Scheduler] 🔧 [개발용] 즉시 실행 플래그 감지. 파이프라인을 트리거합니다.');
    
    runScraperPipeline()
      .then((stats) => console.log('[Scheduler] 🎉 즉시 실행 완료:', stats))
      .catch((err) => console.error('[Scheduler] ❌ 즉시 실행 실패:', err.message));
  }
}