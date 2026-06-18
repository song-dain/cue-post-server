const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * AI 툴 정보를 바탕으로 전문가 페르소나 프롬프트를 생성합니다.
 */
async function generateProfessionalPrompt(title, summaryEn) {
  const systemInstruction = `
    너는 AI 도구 대시보드에 탑재할 '전문가용 시스템 프롬프트(Persona/Instruction)'를 제작하는 마스터 프롬프트 엔지니어다.
    입력받은 AI 툴의 이름(Title)과 영문 설명(Description)을 기반으로, 유저가 이 툴을 복사해서 ChatGPT나 Claude에 붙여넣었을 때 "가장 짜릿하고 깊이 있는 아웃풋"을 뽑아낼 수 있는 [역할 지정형 프롬프트]를 창조해라.
    
    단순히 "이 툴은 이런 기능을 합니다"라고 설명하지 마라.
    반드시 아래 구조의 순수한 JSON 객체 형식으로만 응답해라. 다른 부연 설명이나 마크다운은 절대로 붙이지 마라.
    {
      "prompt_ko": "한국어로 번역 및 최적화된 전문가 페르소나 프롬프트 지침서 문장",
      "prompt_en": "English optimized professional persona instruction prompt"
    }
  `;

  const userContent = `AI 툴 이름: ${title}\n설명: ${summaryEn}`;

  const aiResponse = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: userContent,
    config: {
      systemInstruction: systemInstruction,
      responseMimeType: 'application/json', 
    }
  });

  return JSON.parse(aiResponse.text);
}

module.exports = { generateProfessionalPrompt };