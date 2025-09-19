import express from "express";
import puppeteer from "puppeteer";
import dotenv from "dotenv";
import { Client } from "@notionhq/client";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const port = 3000;

// Notion 클라이언트
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const notionDatabaseId = process.env.NOTION_DATABASE_ID;

// Claude API 호출
async function summarizeWithClaude(content) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.CLAUDE_API_KEY,
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
  } catch (e) {
    console.error("❌ Claude 요약 실패:", e);
    return "요약 실패";
  }
}

// Notion 저장
async function saveToNotion({ title, summary, url }) {
  try {
    const today = new Date().toISOString();
    await notion.pages.create({
      parent: { database_id: notionDatabaseId },
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
    console.error("❌ Notion 저장 실패:", err);
  }
}

// 본문 크롤링 (Firecrawl)
async function extractArticleContent(url) {
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, extract: true }),
    });
    const data = await res.json();
    return data?.content ?? "❗본문 없음";
  } catch (err) {
    console.error("🔥 Firecrawl 오류:", err);
    return "❗본문 없음";
  }
}

// 뉴스 목록 추출 (Puppeteer)
async function getLatestNewsUrls() {
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  await page.goto("https://www.boannews.com/media/t_list.asp", { timeout: 0 });

  await page.waitForSelector("a.news_txt");

  const links = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a.news_txt"));
    return anchors.slice(0, 3).map(a => ({
      title: a.innerText.trim(),
      url: "https://www.boannews.com" + a.getAttribute("href"),
    }));
  });

  await browser.close();
  return links;
}

// 🔥 전체 파이프라인 실행
app.post("/firecrawl", async (req, res) => {
  try {
    console.log("🚀 보안뉴스 수집 시작...");

    const articles = await getLatestNewsUrls();

    for (const [i, { title, url }] of articles.entries()) {
      console.log(`\n📰 [${i + 1}] 본문 크롤링: ${url}`);

      const content = await extractArticleContent(url);
      if (!content || content.startsWith("❗")) throw new Error("본문 없음");

      const summary = await summarizeWithClaude(content);

      await saveToNotion({ title, summary, url });
    }

    res.send("✅ 전체 작업 완료 (크롤링 → 요약 → Notion)");
  } catch (err) {
    console.error("❌ 크롤링 오류:", err);
    res.status(500).send("크롤링 실패: " + err.message);
  }
});

app.listen(port, () => {
  console.log(`✅ MCP 서버 실행됨: http://localhost:${port}`);
});
