import dotenv from "dotenv";
import fetch from "node-fetch";
import { Client } from "@notionhq/client";

dotenv.config();

// 🔑 환경변수
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Notion 클라이언트
const notion = new Client({ auth: NOTION_API_KEY });

// 🔎 Firecrawl로 보안뉴스 목록 가져오기
async function getLatestNewsUrls() {
  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: "https://www.boannews.com/media/t_list.asp",
      extract: false,
      render: true,
    }),
  });

  const data = await res.json();
  const html = data?.html ?? "";

  // 정규식으로 상위 3개 기사 추출
  const matches = html.matchAll(
    /<a[^>]*href="(\/media\/view\.asp\?idx=\d+)"[^>]*class="news_txt"[^>]*>(.*?)<\/a>/g
  );

  const results = [];
  for (const m of matches) {
    results.push({
      url: "https://www.boannews.com" + m[1],
      title: m[2].trim(),
    });
    if (results.length >= 3) break;
  }

  console.log("📌 추출된 기사:", results);
  return results;
}

// 📄 기사 본문 가져오기
async function extractArticleContent(url) {
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

// 🚀 전체 실행 파이프라인
async function runPipeline() {
  console.log("🚀 보안뉴스 수집 시작...");
  const articles = await getLatestNewsUrls();

  for (const { title, url } of articles) {
    console.log(`📰 기사 처리중: ${title} (${url})`);
    const content = await extractArticleContent(url);
    if (!content || content.startsWith("❗")) {
      console.warn("본문 없음, 건너뜀");
      continue;
    }
    const summary = await summarizeWithClaude(content);
    await saveToNotion({ title, summary, url });
  }

  console.log("✅ 전체 작업 완료 (크롤링 → 요약 → Notion)");
}

runPipeline();
