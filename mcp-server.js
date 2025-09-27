const dotenv = require("dotenv");
const fetch = require("node-fetch");
const { Client } = require("@notionhq/client");
const cheerio = require("cheerio");
const iconv = require('iconv-lite');
const OpenAI = require("openai");

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

const notion = new Client({ auth: NOTION_API_KEY });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function getTodayUrl() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  
  // 오늘 날짜로 t_list.asp 검색 URL 생성
  return `https://www.boannews.com/media/t_list.asp?kind=2&s_y=${year}&s_m=${month}&s_d=${day}&e_y=${year}&e_m=${month}&e_d=${day}`;
}

async function getLatestNewsFromHtml() {
  const url = getTodayUrl();
  
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    // euc-kr 인코딩 처리
    const buffer = await res.buffer();
    const htmlContent = iconv.decode(buffer, 'euc-kr');

    if (!htmlContent) {
      console.error("🔥 스크랩 실패: 본문이 비어있습니다.");
      return [];
    }

    const $ = cheerio.load(htmlContent);
    const articles = [];
    const existingUrls = new Set();
    
    // 메인 뉴스 (.news_main)와 리스트 뉴스 (.news_list) 모두 처리
    $('.news_main, .news_list').each((index, element) => {
      const isMain = $(element).hasClass('news_main');
      const titleElement = isMain ? $(element).find('.news_main_title a') : $(element).find('a .news_txt');
      const title = titleElement.text().trim();
      const relativeUrl = isMain ? titleElement.attr('href') : $(element).find('a').first().attr('href');

      if (title && relativeUrl) {
        const absoluteUrl = `https://www.boannews.com${relativeUrl.replace('../', '/')}`;
        // 중복 URL 검사 및 추가
        if (!existingUrls.has(absoluteUrl)) {
          articles.push({ title, url: absoluteUrl });
          existingUrls.add(absoluteUrl);
        }
      }
    });

    console.log(`📌 총 ${articles.length}개 기사 추출 완료`);
    return articles;
  } catch (err) {
    console.error("🔥 HTML 스크랩 오류:", err);
    return [];
  }
}

async function extractArticleContent(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const buffer = await res.buffer();
    const htmlContent = iconv.decode(buffer, 'euc-kr');
    
    const $ = cheerio.load(htmlContent);
    // 본문 추출 시도 (두 가지 주요 셀렉터 사용)
    let content = $('#news_content').text().trim();
    
    if (!content) {
      content = $('div[itemprop="articleBody"]').text().trim();
    }
    
    if (content.length > 100) {
      console.log('✅ 본문 추출 성공');
      return content;
    } else {
      console.warn('⚠️ 본문 추출 실패: 올바른 CSS 셀렉터를 찾을 수 없거나 내용이 너무 짧습니다.');
      return "❗본문 없음";
    }

  } catch (err) {
    console.error("🔥 본문 추출 오류:", err);
    return "❗본문 없음";
  }
}

// OpenAI를 이용한 보안 관련 기사 필터링
async function isSecurityArticle(title) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "user", content: `다음 기사 제목이 보안 관련 기사인지 '예' 또는 '아니오'로만 답해줘.\n\n기사 제목: ${title}` },
      ],
    });
    const answer = completion.choices[0].message.content.trim();
    
    console.log(`🤖 "${title}" -> 판단: ${answer}`);
    return answer.includes('예');
  } catch (err) {
    console.error("🤖 OpenAI 필터링 오류:", err);
    return false;
  }
}

// ✅ 구조화된 보고서 생성을 위한 프롬프트 적용
async function createStructuredReport(content) {
  try {
    if (!content || content.startsWith("❗")) {
      console.error("⚠️ 요약할 본문이 없어 보고서 생성 실패");
      return "보고서 생성 실패";
    }

    const prompt = `다음 기사 내용을 바탕으로 '보안 경고 보고서'를 작성해줘. 보고서는 다음 항목을 포함해야 해. 각 항목을 명확한 제목과 함께 간결한 문장으로 정리해줘.
    \n\n- 배경 및 위협: 왜 위협이 증가하는지, 공격의 목적은 무엇인지 간결하게 요약해줘.
    \n- 공격 수법: 공격이 무엇인지 정의하고, 어떤 수법으로 공격이 이뤄지는지 설명해줘.
    \n- 정부의 대응 및 주의사항: 정부의 대응 방안과 사용자들이 어떤 점을 주의해야 하는지 핵심적인 내용을 정리해줘.
    \n- 분석 및 특징: 1차 관련 사례를 바탕으로 주로 어떤 유형의 공격이 발생했는지 분석해줘.
    \n\n기사 내용:\n${content}`;
    
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "user", content: prompt },
      ],
    });
    const report = completion.choices[0].message.content.trim();
    
    if (!report) {
      throw new Error("OpenAI API에서 보고서 내용을 반환하지 않았습니다.");
    }
    return report;
  } catch (err) {
    console.error("🤖 OpenAI API 호출 오류:", err);
    return "보고서 생성 실패";
  }
}

async function saveToNotion({ title, summary, url }) {
  const today = new Date().toISOString();
  try {
    await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        "제목": {
          title: [{ text: { content: title } }],
        },
        "날짜": {
          date: { start: today },
        },
        "URL": {
          url: url,
        },
        "내용": {
          // 구조화된 보고서 내용을 Notion의 '내용' 필드에 저장
          rich_text: [{ text: { content: summary } }],
        },
      },
    });
    console.log(`✅ Notion 저장 완료: ${title}`);
  } catch (err) {
    console.error(`📝 Notion 저장 오류: ${title}`, err);
    console.error(err);
  }
}

async function runPipeline() {
  console.log("🚀 자체 스크래핑 기반 보안뉴스 수집 시작...");
  const articles = await getLatestNewsFromHtml();
  if (articles.length === 0) {
    console.error("❌ 수집된 기사가 없습니다.");
    return;
  }
  for (const { title, url } of articles) {
    console.log(`\n📰 처리 중: ${title}`);
    console.log(`🔗 URL: ${url}`);
    
    const isRelevant = await isSecurityArticle(title);
    if (!isRelevant) {
      console.log("➡️ 보안 관련 기사가 아님, 건너뜀.");
      continue;
    }

    const content = await extractArticleContent(url);
    if (!content || content.startsWith("❗")) {
      console.warn("⚠️ 본문이 없음, 건너뜀");
      continue;
    }
    
    const report = await createStructuredReport(content);
    await saveToNotion({ title, summary: report, url });
  }
  console.log("✅ 전체 파이프라인 완료!");
}

runPipeline().catch(console.error);
