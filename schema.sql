-- ════════════════════════════════════════════════════════════════
-- CuePost — 튜닝된 Supabase DB 스키마 (심플 & 고성능)
-- ════════════════════════════════════════════════════════════════

-- 1. 메인 AI 툴 테이블 생성
CREATE TABLE ai_tools (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  source_url      TEXT NOT NULL,
  description_en  TEXT,
  summary_ko      TEXT,
  main_category   TEXT CHECK (main_category IN (
                    'developer', 'marketer', 'designer', 'researcher',
                    'writer', 'sales', 'hr', 'finance', 'general'
                  )),
  tags_ko         TEXT[],          -- 한국어 소분류 태그 배열
  tags_en         TEXT[],          -- 영어 소분류 태그 배열
  raw_category    TEXT,            -- 원문 카테고리 (LLM 분류 전 보존)
  llm_confidence  NUMERIC(3,2),    -- LLM 분류 신뢰도 (0.00 ~ 1.00)
  status          TEXT DEFAULT 'published' CHECK (status IN (
                    'published', 'pending_review', 'archived'
                  )),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 2. 중복 방지 및 검색 성능을 위한 인덱스 설정
CREATE UNIQUE INDEX tools_source_url_idx ON ai_tools (source_url); -- 🌟 핵심: Upsert 충돌 방지용
CREATE INDEX tools_main_category_idx ON ai_tools (main_category);
CREATE INDEX tools_status_idx ON ai_tools (status);
CREATE INDEX tools_tags_en_idx ON ai_tools USING GIN (tags_en);   -- 배열 검색 최적화

-- 3. 데이터 수정 시 자동으로 updated_at을 갱신해 주는 고마운 트리거
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN 
  NEW.updated_at = now(); 
  RETURN NEW; 
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON ai_tools
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 4. RLS 보안 설정 (보안 사수)
ALTER TABLE ai_tools ENABLE ROW LEVEL SECURITY;

-- 일반 유저나 프론트엔드 앱은 'published' 상태인 데이터만 자유롭게 읽을 수 있음
CREATE POLICY "Public read published tools"
  ON ai_tools FOR SELECT
  USING (status = 'published');