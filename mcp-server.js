import dotenv from "dotenv";
import fetch from "node-fetch";
import { Client } from "@notionhq/client";

dotenv.config();

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

const notion = new Client({ auth: NOTION_API_KEY });

// 🔎 Firecrawl Search → 기사 URL 가져오기
async function getLatestNewsUrls() {
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: "site:boannews.com",  // ✅ 단순히 도메인 검색
        num_results: 3,
      }),
    });

    const data = await res.json();
    const results = data?.results?.map(r => ({
      title: r.title,
      url: r.url,
    })) ?? [];

    console.log("📌 Firecrawl 검색 결과:", results);
    return results;
  } catch (err) {
    console.error("🔥 Firecrawl 검색 오류:", err);
    return [];
  }
}

// 📄 Firecrawl Scrape → 본문 추출
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

// 🤖 Claude 요약
async function summarizeWithClaude(content) {
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
}

// 📝 Notion 저장
async function saveToNotion({ title, summary, url }) {
  const today = new Date().toISOString();
  await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      제목: {
        title: [{ text: { content: title } }],
      },
      날짜: {
        date: { start: today },
      },
      URL: {
        url: url,
      },
      내용: {
        rich_text: [{ text: { content: summary } }],
      },
    },
  });
  console.log(`✅ Notion 저장 완료: ${title}`);
}

// 🚀 실행
async function runPipeline() {
  console.log("🚀 Firecrawl 기반 보안뉴스 수집 시작...");
  const articles = await getLatestNewsUrls();

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
