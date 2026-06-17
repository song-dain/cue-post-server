require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const deepl = require('deepl-node');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const translator = new deepl.Translator(process.env.DEEPL_API_KEY);

// 🧠 5대 직무 자동 분류 알고리즘
function getJobCategory(title, enDescription, tagsEn) {
  const targetText = [...tagsEn, title, enDescription].join(' ').toLowerCase();
  if (targetText.includes('code') || targetText.includes('developer') || targetText.includes('api') || targetText.includes('programming')) {
    return 'developer';
  }
  if (targetText.includes('design') || targetText.includes('image') || targetText.includes('logo') || targetText.includes('video') || targetText.includes('avatar')) {
    return 'designer';
  }
  if (targetText.includes('marketing') || targetText.includes('seo') || targetText.includes('copywrit') || targetText.includes('sales') || targetText.includes('social')) {
    return 'marketer';
  }
  if (targetText.includes('meeting') || targetText.includes('summary') || targetText.includes('calendar') || targetText.includes('schedule') || targetText.includes('workflow')) {
    return 'pm-hr';
  }
  return 'individual';
}

async function startCrawling() {
  try {
    const scrapedCards = [];
    const maxPages = 2; // 상위 2페이지 타겟

    console.log('🚀 [구글 번역 + 이미지 + 5대 직무 동적 태그 분류] 엔진 가동...');

    for (let page = 1; page <= maxPages; page++) {
      console.log(`\n📄 [${page} / ${maxPages} 페이지] 웹사이트 직접 파싱 중...`);
      
      const targetUrl = `https://www.futurepedia.io/ai-tools/personal-assistant?verified=true&sort=popular&page=${page}`;
      const response = await axios.get(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      const $ = cheerio.load(response.data);
      const cards = $('.flex.flex-col.bg-card').toArray();

      for (const card of cards) {
        const $card = $(card);
        const title = $card.find('p.text-xl.font-semibold.text-slate-700').text().trim();
        const enDescription = $card.find('p.text-muted-foreground').text().trim();

        // 🖼️ [수정 복구 1] 이미지 크롤링 주소 추출 파트 정상 복구!
        let imageUrl = $card.find('img').attr('src') || $card.find('img').attr('data-src') || null;
        if (imageUrl && imageUrl.startsWith('/')) {
          imageUrl = `https://www.futurepedia.io${imageUrl}`;
        }

        const tags_en = [];
        $card.find('.text-ice-500 a').each((_, tag) => {
          tags_en.push($(tag).text().trim());
        });
        if (tags_en.length === 0) tags_en.push('Personal Assistant');

        if (title && enDescription) {
          
          // 🛡️ 1단계: Supabase 중복 검사
          const { data: existingCard, error: checkError } = await supabase
            .from('cards')
            .select('title')
            .eq('title', title)
            .maybeSingle();

          if (checkError) {
            console.error(`⚠️ DB 조회 오류 (${title}):`, checkError.message);
            continue;
          }

          // [수정 복구 2] 중복되어 있던 조건문을 하나로 깔끔하게 통합
          if (existingCard) {
            console.log(`⏭️ [중복 패스] '${title}' (이미 DB에 존재함)`);
            continue;
          }
          
          // 🔤 1. DeepL로 카드 본문 번역 (타겟 언어는 'ko')
          console.log(`🌐 [DeepL 번역] '${title}' 본문 작업 중...`);
          let koDescription = '';
          try {
            // 주입 파라미터 스펙: (텍스트, 출발언어_null이면자동, 도착언어)
            const res = await translator.translateText(enDescription, null, 'ko');
            koDescription = res.text;
          } catch (err) {
            console.error(`⚠️ DeepL 본문 에러:`, err.message);
            koDescription = `[임시 번역] ${enDescription}`;
          }

          // 🏷️ 2. DeepL로 태그 배열 일괄 압축 번역
          console.log(`🏷️ [DeepL 태그] '${title}' 태그 압축 작업 중...`);
          let tags_ko = [];
          if (tags_en.length > 0) {
            try {
              const combinedTagsEn = tags_en.join(' ||| ');
              const res = await translator.translateText(combinedTagsEn, null, 'ko');
              tags_ko = res.text.split('|||').map(tag => tag.trim());
            } catch (err) {
              console.error(`⚠️ DeepL 태그 에러:`, err.message);
              tags_ko = [...tags_en];
            }
          }
          
          // 💼 3. 직무 자동 분류 알고리즘 매칭
          const category = getJobCategory(title, enDescription, tags_en);
          
          // 📦 4. 최종 적재 오브젝트 빌드
          scrapedCards.push({
            category: category,
            title: title,
            image_url: imageUrl, // 이제 에러 없이 완벽하게 변수가 매핑됩니다!
            summary_en: enDescription,
            summary_ko: koDescription,
            tags_en: tags_en,
            tags_ko: tags_ko,
            prompt_ko: null,
            prompt_en: null
          });
          
          console.log(`✅ 데이터셋 조립 완료: ${title} -> 한글 태그: [${tags_ko.join(', ')}]`);
        }
      }
    }

    console.log(`\n✨ [수집 완료] 총 ${scrapedCards.length}개의 번역 데이터셋 완성!`);
    
    if (scrapedCards.length === 0) {
        console.log('🎉 [알림] 새로 추가할 카드가 없습니다.');
        return;
    }

    console.log('📦 Supabase 컬럼에 적재를 시작합니다...');
    const { data, error } = await supabase
      .from('cards')
      .insert(scrapedCards);

    if (error) {
      console.error('❌ DB 적재 실패:', error.message);
    } else {
      console.log('🎉 완벽합니다! 최종 데이터가 무사히 적재되었습니다!');
    }

  } catch (error) {
    console.error('❌ 크롤링 중 치명적 에러:', error.message);
  }
}

startCrawling();