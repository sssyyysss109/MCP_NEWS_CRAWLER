import dotenv from "dotenv";
import fetch from "node-fetch";
import { Client } from "@notionhq/client";
import * as cheerio from "cheerio";

dotenv.config();

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

const notion = new Client({ auth: NOTION_API_KEY });

// 🔎 Firecrawl Scrape → HTML 페이지에서 기사 목록 가져오기
async function getLatestNewsFromHtml() {
  const url = "https://www.boannews.com/media/list.asp?kind=1";
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, pageOptions: { onlyMainContent: true } }),
    });

    const data = await res.json();
    const htmlContent = data?.content;

    if (!htmlContent) {
      console.error("🔥 Firecrawl 스크랩 실패: 본문이 비어있습니다.");
      return [];
    }

    const $ = cheerio.load(htmlContent);
    const articles = [];
    
    // HTML 구조에 맞춰 기사 제목과 URL을 추출합니다.
    $('.news_list').find('a.news_list_tit').each((index, element) => {
      if (articles.length >= 3) return false;
      
      const title = $(element).text().trim();
      const relativeUrl = $(element).attr('href');
      const absoluteUrl = `https://www.boannews.com/media/${relativeUrl}`;

      if (title && absoluteUrl) {
        articles.push({ title, url: absoluteUrl });
      }
    });

    console.log("📌 HTML 페이지에서 추출한 최신 기사:", articles);
    return articles;
  } catch (err) {
    console.error("🔥 HTML 스크랩 오류:", err);
    return [];
  }
}

// 📄 Firecrawl Scrape → 본문 추출 (기존 함수 재사용)
async function extractArticleContent(url) {
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, extract: true }),
    });
    const data = await res.json();
    return data?.content ?? "❗본문 없음";
  } catch (err) {
    console.error("🔥 Firecrawl 본문 추출 오류:", err);
    return "❗본문 없음";
  }
}

// 🤖 Claude 요약 (기존 함수 재사용)
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
            content: `다음 기사 내용을 한국어로 간결하게 요약해줘:\n\n${content}`,
          },
        ],
      }),
    });

    const data = await res.json();
    return data?.content?.[0]?.text ?? "요약 실패";
  } catch (err) {
    console.error("🤖 Claude API 호출 오류:", err);
    return "요약 실패";
  }
}

// 📝 Notion 저장 (기존 함수 재사용)
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
  }
}

// 🚀 실행
async function runPipeline() {
  console.log("🚀 Firecrawl 기반 보안뉴스 수집 시작...");
  const articles = await getLatestNewsFromHtml();

  for (const { title, url } of articles) {
    console.log(`📰 기사: ${title} (${url})`);
    const content = await extractArticleContent(url);
    if (!content || content.startsWith("❗")) {
      console.warn("본문 없음, 건너뜀");
      continue;
    }
    const summary = await summarizeWithClaude(content);
    await saveToNotion({ title, summary, url });
  }

  console.log("✅ 전체 완료 (Firecrawl → Claude → Notion)");
}

runPipeline();