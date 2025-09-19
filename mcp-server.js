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
// 모델 이름을 'gemini-1.0-pro'로 변경했습니다.
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

// 🔎 HTML 페이지에서 기사 목록 가져오기 (인코딩 문제 해결)
async function getLatestNewsFromHtml() {
  const url = "https://www.boannews.com/media/list.asp?kind=1";
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    // EUC-KR 인코딩 변환
    const buffer = await res.buffer();
    const htmlContent = iconv.decode(buffer, 'euc-kr');

    if (!htmlContent) {
      console.error("🔥 스크랩 실패: 본문이 비어있습니다.");
      return [];
    }

    const $ = cheerio.load(htmlContent);
    const articles = [];
    
    // 💡 주요 기사 추출 (.news_main)
    $('.news_main').each((index, element) => {
      const titleElement = $(element).find('.news_main_title a');
      const title = titleElement.text().trim();
      const relativeUrl = titleElement.attr('href');

      if (title && relativeUrl && articles.length < 5) {
        const absoluteUrl = `https://www.boannews.com${relativeUrl.replace('../', '/')}`;
        articles.push({ title, url: absoluteUrl });
      }
    });

    // 💡 일반 기사 추출 (.news_list)
    $('.news_list').each((index, element) => {
      const titleElement = $(element).find('a .news_txt');
      const title = titleElement.text().trim();
      const relativeUrl = $(element).find('a').first().attr('href');

      if (title && relativeUrl && articles.length < 5) {
        const absoluteUrl = `https://www.boannews.com${relativeUrl.replace('../', '/')}`;
        articles.push({ title, url: absoluteUrl });
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

    // EUC-KR 인코딩 변환
    const buffer = await res.buffer();
    const htmlContent = iconv.decode(buffer, 'euc-kr');
    
    const $ = cheerio.load(htmlContent);
    
    // 1차 시도: news_content ID로 본문 추출
    let content = $('#news_content').text().trim();
    
    // 2차 시도: 만약 내용이 없으면 itemprop="articleBody"로 추출
    if (!content) {
      content = $('div[itemprop="articleBody"]').text().trim();
    }
    
    if (content.length > 100) { // 최소한의 본문 길이 확인
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

// 🤖 Gemini 요약
// 🤖 Gemini 요약 (프롬프트 제어 로직 추가)
async function summarizeWithGemini(title, content) {
  try {
    let prompt = "";
    const keywords = ['사건', '사고', '해킹', '공격', '침해', '유출'];
    const isIncident = keywords.some(keyword => title.includes(keyword) || content.includes(keyword));

    if (isIncident) {
      // 사건/사고 관련 기사 프롬프트
      prompt = `다음 보안 기사 내용을 읽고 '문제 상황', '원인', '해결 방안'의 3가지 항목으로 나누어 정리해줘.
      1. 문제 상황:
      2. 원인:
      3. 해결 방안:
      \n\n기사 내용:\n${content}`;
      console.log("✅ 사건/사고용 프롬프트 사용");
    } else {
      // 일반 기사 프롬프트
      prompt = `다음 보안 기사 내용을 한국어로 4문장 이내로 간결하게 요약해줘. 핵심 내용과 보안 이슈를 중심으로 정리해줘.
      \n\n기사 내용:\n${content}`;
      console.log("✅ 일반 기사용 프롬프트 사용");
    }

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