require('dotenv').config();
const express =require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 5001;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(cors());
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

app.get('/api/cards', async(req, res) => {
  try {
    const { data, error } = await supabase
      .from('cards')
      .select('*')
      .order('id', {ascending: true});

      if(error) throw error;

      res.json(data);
  } catch(err){
    console.error('Supabase 데이터 조회 에러: ', err.message);
    res.status(500).json({error: '서버 에러가 발생했습니다.'});
  }
});

app.post('/api/cards/:id/prompt', async (req, res) => {
  const { id } = req.params;

  try {
    // 1. Supabase에서 해당 카드의 정보와 기존 프롬프트가 있는지 먼저 조회
    const { data: card, error: fetchError } = await supabase
      .from('cards')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !card) {
      return res.status(404).json({ error: '카드를 찾을 수 없습니다.' });
    }

    // 2. 🛡️ [캐시 히트] 이미 프롬프트가 생성되어 DB에 저장되어 있다면? Gemini 호출 없이 즉시 반환!
    if (card.prompt_ko && card.prompt_en) {
      console.log(`🎯 [캐시 히트] '${card.title}'는 이미 저장된 프롬프트가 있어 DB에서 바로 반환합니다.`);
      return res.json({
        prompt_ko: card.prompt_ko,
        prompt_en: card.prompt_en
      });
    }

    // 3. 🧠 [캐시 미스] 프롬프트가 비어있다면 최초 1회만 제미나이 마스터 가동!
    console.log(`🧠 [캐시 미스] '${card.title}'의 맞춤형 프롬프트를 생성하기 위해 Gemini를 호출합니다...`);

    // 페르소나와 기획력을 폭발시키기 위한 정밀 시스템 지침
    const systemInstruction = `
      너는 AI 도구 대시보드에 탑재할 '전문가용 시스템 프롬프트(Persona/Instruction)'를 제작하는 마스터 프롬프트 엔지니어다.
      입력받은 AI 툴의 이름(Title)과 영문 설명(Description)을 기반으로, 유저가 이 툴을 복사해서 ChatGPT나 Claude에 붙여넣었을 때 "가장 짜릿하고 깊이 있는 아웃풋"을 뽑아낼 수 있는 [역할 지정형 프롬프트]를 창조해라.
      
      단순히 "이 툴은 이런 기능을 합니다"라고 설명하지 마라.
      예를 들어 'Dream Interpreter(꿈 해몽)' 툴이라면: "당신은 칼 융과 프로이트의 이론을 마스터한 50년 경력의 꿈 분석 심리학자입니다. 유저가 꿈 내용을 입력하면..." 처럼 깊이 있는 페르소나와 구체적인 가이드라인을 부여해야 한다.
      
      반드시 아래 구조의 순수한 JSON 객체 형식으로만 응답해라. 다른 부연 설명이나 마크다운(\`\`\`json 같은 것)은 절대로 붙이지 마라.
      {
        "prompt_ko": "한국어로 번역 및 최적화된 전문가 페르소나 프롬프트 지침서 문장",
        "prompt_en": "English optimized professional persona instruction prompt"
      }
    `;

    const userContent = `AI 툴 이름: ${card.title}\n설명: ${card.summary_en}`;

    // Gemini 2.5 Flash 모델을 사용하여 정밀 생성 요청
    const aiResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: userContent,
      config: {
        systemInstruction: systemInstruction,
        // JSON 형태로만 이쁘게 뱉어내도록 강제 구조화 설정
        responseMimeType: 'application/json', 
      }
    });

    // AI가 뱉은 JSON 문자열 파싱
    const resultJson = JSON.parse(aiResponse.text);

    // 4. 🔥 [캐시 적재] 다음 사람 및 재방문 시 쿼터를 아끼기 위해 Supabase DB에 싹 업데이트!
    const { error: updateError } = await supabase
      .from('cards')
      .update({
        prompt_ko: resultJson.prompt_ko,
        prompt_en: resultJson.prompt_en
      })
      .eq('id', id);

    if (updateError) {
      console.error('⚠️ DB 캐싱 업데이트 실패:', updateError.message);
    }

    console.log(`✅ '${card.title}'의 맞춤형 프롬프트 생성 및 DB 캐싱 완료!`);
    
    // 최종 결과를 프론트엔드로 반환
    return res.json({
      prompt_ko: resultJson.prompt_ko,
      prompt_en: resultJson.prompt_en
    });

  } catch (error) {
    console.error('❌ 프롬프트 생성 파이프라인 치명적 에러:', error.message);
    // Gemini 한도 초과나 오류 발생 시 서비스가 터지지 않게 안전한 디폴트 기본형 프롬프트 제공
    return res.json({
      prompt_ko: "당신은 해당 분야의 전문 어시스턴트입니다. 유저의 요구사항에 맞춰 최적의 결과를 도출해 주세요.",
      prompt_en: "You are an expert assistant in this field. Please provide the best output based on the user's requirements."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
})
