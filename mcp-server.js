import dotenv from "dotenv";
import fetch from "node-fetch";
import { Client } from "@notionhq/client";
import * as cheerio from "cheerio";
import iconv from 'iconv-lite';

dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

const notion = new Client({ auth: NOTION_API_KEY });

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

// 🤖 Claude 요약 (오류 로그 개선)
async function summarizeWithClaude(content) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: `다음 보안 기사 내용을 한국어로 3-4문장으로 간결하게 요약해줘. 핵심 내용과 보안 이슈를 중심으로 정리해줘:\n\n${content}`,
          },
        ],
      }),
    });

    if (!res.ok) {
        // API 응답이 성공(2xx)이 아닐 경우, 에러 메시지를 출력합니다.
        const errorData = await res.json();
        console.error(`🤖 Claude API 호출 오류: ${res.status} ${res.statusText}`);
        console.error("자세한 오류 내용:", errorData);
        return "요약 실패";
    }

    const data = await res.json();
    const summary = data?.content?.[0]?.text ?? "요약 실패";
    return summary;
  } catch (err) {
    console.error("🤖 Claude API 호출 오류:", err);
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
    const summary = await summarizeWithClaude(content);
    await saveToNotion({ title, summary, url });
  }
  console.log("✅ 전체 파이프라인 완료!");
}

runPipeline().catch(console.error);