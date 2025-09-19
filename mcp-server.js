import dotenv from "dotenv";
import fetch from "node-fetch";
import { Client } from "@notionhq/client";
import { parseStringPromise } from 'xml2js';

dotenv.config();

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

const notion = new Client({ auth: NOTION_API_KEY });

// 🔎 Firecrawl Scrape → RSS 피드에서 기사 URL과 제목 가져오기
async function getLatestNewsFromRss() {
  const rssUrl = "https://www.boannews.com/rss/all_rss.xml";
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: rssUrl }),
    });

    const data = await res.json();
    const xmlContent = data?.content;

    if (!xmlContent) {
      console.error("🔥 RSS 스크랩 실패: 본문이 비어있습니다.");
      return [];
    }

    // xml2js 라이브러리로 XML 파싱
    const result = await parseStringPromise(xmlContent);
    const articles = result.rss.channel[0].item.slice(0, 3).map(item => ({
      title: item.title[0],
      url: item.link[0],
    }));

    console.log("📌 RSS에서 추출한 최신 기사:", articles);
    return articles;
  } catch (err) {
    console.error("🔥 RSS 스크랩 오류:", err);
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

// 📝 Notion 저장
async function saveToNotion({ title, summary, url }) {
  const today = new Date().toISOString();
  try {
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
  } catch (err) {
    console.error(`📝 Notion 저장 오류: ${title}`, err);
  }
}

// 🚀 실행
async function runPipeline() {
  console.log("🚀 Firecrawl 기반 보안뉴스 수집 시작...");
  const articles = await getLatestNewsFromRss();

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