import dotenv from "dotenv";
import fetch from "node-fetch";
import { Client } from "@notionhq/client";
import * as cheerio from "cheerio";
import iconv from 'iconv-lite';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

const notion = new Client({ auth: NOTION_API_KEY });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

// ✅ 오늘 날짜를 기반으로 검색 URL 생성
function getTodayUrl() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  
  return `https://www.boannews.com/media/t_list.asp?kind=2&s_y=${year}&s_m=${month}&s_d=${day}&e_y=${year}&e_m=${month}&e_d=${day}`;
}

// 🔎 HTML 페이지에서 기사 목록 가져오기 (인코딩 문제 해결)
async function getLatestNewsFromHtml() {
  const url = getTodayUrl(); // ✅ 변경된 URL 사용
  
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const buffer = await res.buffer();
    const htmlContent = iconv.decode(buffer, 'euc-kr');

    if (!htmlContent) {
      console.error("🔥 스크랩 실패: 본문이 비어있습니다.");
      return [];
    }

    const $ = cheerio.load(htmlContent);
    const articles = [];
    const existingUrls = new Set(); // ✅ 중복 검사 로직 추가
    
    $('.news_main, .news_list').each((index, element) => { // ✅ 선택자 통합
      const isMain = $(element).hasClass('news_main');
      const titleElement = isMain ? $(element).find('.news_main_title a') : $(element).find('a .news_txt');
      const title = titleElement.text().trim();
      const relativeUrl = isMain ? titleElement.attr('href') : $(element).find('a').first().attr('href');

      if (title && relativeUrl) {
        const absoluteUrl = `https://www.boannews.com${relativeUrl.replace('../', '/')}`;
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

// 📄 기사 본문 추출 (인코딩 문제 해결)
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
    let content = $('#news_content').text().trim();
    
    if (!content) {
      content = $('div[itemprop="articleBody"]').text().trim();
    }
    
    if (content.length > 100) {
      console.log('✅ 본문 추출 성공');
      return content;
    } else {
      console.log('⚠️ 본문 추출 실패: 올바른 CSS 셀렉터를 찾을 수 없거나 내용이 너무 짧습니다.');
      return "❗본문 없음";
    }

  } catch (err) {
    console.error("🔥 본문 추출 오류:", err);
    return "❗본문 없음";
  }
}

// 🤖 Gemini 필터링 (보안 관련 기사인지 판단)
async function isSecurityArticle(title) {
  try {
    const prompt = `다음 기사 제목이 보안 관련 기사인지 '예' 또는 '아니오'로만 답해줘.
    \n\n기사 제목: ${title}`;
    
    const result = await model.generateContent(prompt);
    const answer = result.response.text().trim();
    
    console.log(`🤖 "${title}" -> 판단: ${answer}`);
    return answer.includes('예');
  } catch (err) {
    console.error("🤖 Gemini 필터링 오류:", err);
    return false;
  }
}

// 🤖 Gemini 요약
async function summarizeWithGemini(content) {
  try {
    if (!content || content.startsWith("❗")) {
      console.error("⚠️ 요약할 본문이 없어 요약 실패");
      return "요약 실패";
    }

    const prompt = `다음 보안 기사 내용을 한국어로 4문장 이내로 간결하게 요약해줘. 핵심 내용과 보안 이슈를 중심으로 정리해줘.
    \n\n기사 내용:\n${content}`;
    
    const result = await model.generateContent(prompt);
    const summary = result.response.text();

    if (!summary) {
      throw new Error("Gemini API에서 요약 내용을 반환하지 않았습니다.");
    }
    return summary;
  } catch (err) {
    console.error("🤖 Gemini API 호출 오류:", err);
    return "요약 실패";
  }
}

// 📝 Notion 저장
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

// 🚀 실행
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
    
    // 🤖 Gemini 필터링 단계 추가
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
    
    const summary = await summarizeWithGemini(content);
    await saveToNotion({ title, summary, url });
  }
  console.log("✅ 전체 파이프라인 완료!");
}

runPipeline().catch(console.error);