// routes/cardRoutes.js
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { generateProfessionalPrompt } from '../services/geminiService.js';

const router = express.Router();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 카드 목록 조회
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 12;
    const category = req.query.category;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supabase.from('cards').select('*', { count: 'exact' });

    if (category && category !== 'all' && category !== '') {
      query = query.eq('category', category);
    }

    const { data, count, error } = await query
      .order('id', { ascending: true })
      .range(from, to);

    if (error) throw error;

    res.json({
      cards: data || [],
      totalCount: count || 0,
      totalPages: Math.ceil((count || 0) / limit),
      currentPage: page,
    });
  } catch (err) {
    console.error('Supabase 데이터 조회 에러:', err.message);
    res.status(500).json({ error: '서버 에러가 발생했습니다.' });
  }
});

// 프롬프트 생성
router.post('/:id/prompt', async (req, res) => {
  const { id } = req.params;
  try {
    const { data: card, error: fetchError } = await supabase
      .from('cards')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !card) {
      return res.status(404).json({ error: '카드를 찾을 수 없습니다.' });
    }

    if (card.prompt_ko && card.prompt_en) {
      return res.json({ prompt_ko: card.prompt_ko, prompt_en: card.prompt_en });
    }

    const resultJson = await generateProfessionalPrompt(card.title, card.summary_en);

    await supabase
      .from('cards')
      .update({ prompt_ko: resultJson.prompt_ko, prompt_en: resultJson.prompt_en })
      .eq('id', id);

    return res.json(resultJson);
  } catch (error) {
    console.error('프롬프트 생성 에러:', error.message);
    return res.json({
      prompt_ko: '당신은 해당 분야의 전문 어시스턴트입니다.',
      prompt_en: 'You are an expert assistant in this field.',
    });
  }
});

export default router;