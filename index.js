/**
 * CuePost - Express App Entry Point
 * ─────────────────────────────────────────────────────────────────
 * 기존 Express MVC 구조에 스케줄러를 non-blocking으로 연동
 * ─────────────────────────────────────────────────────────────────
 */

import 'dotenv/config';
import express from 'express';
import { initScheduler } from './services/batchScheduler.js';
import { runScraperPipeline } from './services/scraperService.js';
import cors from 'cors';

const app = express();

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? process.env.ALLOWED_ORIGIN  // .env에 Vercel URL 넣기
    : '*',
}));

// ── 기존 라우터 연결 (기존 구조 유지) ───────────────────────────
// import toolsRouter from './routes/tools.js';
// app.use('/api/tools', toolsRouter);

// ── 스크래퍼 수동 트리거 API (운영 편의용) ───────────────────────
app.post('/api/admin/scraper/run', async (req, res) => {
  // 간단한 Admin 인증 (실제 운영 시 JWT 미들웨어로 교체)
  if (req.headers['x-admin-key'] !== process.env.ADMIN_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 파이프라인을 블로킹하지 않고 백그라운드 실행 후 즉시 응답 (UX 최적화)
  res.json({ message: '파이프라인 시작됨. 결과는 로그를 확인하세요.' });
  
  runScraperPipeline().catch((err) =>
    console.error('[Manual Trigger] 실패:', err.message)
  );
});

// ── 서버 시작 ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[App] 서버 실행 중: http://localhost:${PORT}`);

  // 💡 NODE_ENV가 비어있으면 로컬 환경('development')으로 간주하여 무조건 즉시 실행이 켜지도록 방어 처리
  const env = process.env.NODE_ENV || 'development';
  const isDev = env === 'development' || env === 'local';
  
  console.log(`[App] 현재 실행 환경: ${env} (즉시 실행 여부: ${isDev})`);
  
  // 스케줄러 초기화 및 등록
  initScheduler(isDev);
});

export default app;

/*
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cardRoutes = require('./routes/cardRoutes'); 

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

// 카드 관련 API 라우터 매핑
app.use('/api/cards', cardRoutes);

app.listen(PORT, () => {
  console.log(`🚀 서버가 포트 ${PORT}에서 작동 중입니다!`);
});

*/