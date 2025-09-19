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
      body: JSON.stringify({ 
        url, 
        formats: ["html"],
        onlyMainContent: false // 전체 컨텐츠 가져오기
      }),
    });

    const data = await res.json();
    const htmlContent = data?.html;

    if (!htmlContent) {
      console.error("🔥 Firecrawl 스크랩 실패: HTML이 비어있습니다.");
      return [];
    }

    const $ = cheerio.load(htmlContent);
    const articles = [];
    
    console.log("📌 HTML 파싱 시작...");
    
    // 주요 기사들 (.news_main)
    $('.news_main').each((index, element) => {
      if (articles.length >= 3) return false;
      
      const titleElement = $(element).find('.news_main_title a');
      const title = titleElement.text().trim();
      const relativeUrl = titleElement.attr('href');
      
      if (title && relativeUrl) {
        const absoluteUrl = relativeUrl.startsWith('http') 
          ? relativeUrl 
          : `https://www.boannews.com${relativeUrl}`;
        
        articles.push({ title, url: absoluteUrl });
        console.log(`✅ 주요기사 발견: ${title}`);
      }
    });

    // 일반 기사들 (.news_list)도 추가로 수집
    $('.news_list').each((index, element) => {
      if (articles.length >= 5) return false;
      
      const titleElement = $(element).find('a .news_txt');
      const title = titleElement.text().trim();
      const linkElement = $(element).find('a').first();
      const relativeUrl = linkElement.attr('href');
      
      if (title && relativeUrl) {
        const absoluteUrl = relativeUrl.startsWith('http') 
          ? relativeUrl 
          : `https://www.boannews.com${relativeUrl}`;
        
        articles.push({ title, url: absoluteUrl });
        console.log(`✅ 일반기사 발견: ${title}`);
      }
    });

    console.log(`📌 총 ${articles.length}개 기사 추출 완료`);
    return articles;
  } catch (err) {
    console.error("🔥 HTML 스크랩 오류:", err);
    return [];
  }
}

// 📄 간단한 웹 페이지 fetch로 본문 추출 (Firecrawl 대신)
async function extractArticleContentSimple(url) {
  try {
    console.log(`📖 기사 본문 추출 시도: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const html = await response.text();
    const $ = cheerio.load(html);
    
    // 보안뉴스 기사 본문 구조 분석
    let content = '';
    
    // 다양한 본문 셀렉터 시도
    const contentSelectors = [
      '.news_content',
      '#news_content', 
      '.article_content',
      '.view_txt',
      '#view_area',
      '.content_area'
    ];
    
    for (const selector of contentSelectors) {
      const element = $(selector);
      if (element.length > 0) {
        content = element.text().trim();
        if (content.length > 100) { // 충분한 내용이 있을 때만
          console.log(`✅ 본문 추출 성공 (${selector}): ${content.substring(0, 100)}...`);
          break;
        }
      }
    }
    
    // 셀렉터로 찾지 못했다면 전체 텍스트에서 추출
    if (!content || content.length < 100) {
      const bodyText = $('body').text();
      // 기사 내용으로 보이는 부분 추출 (간단한 휴리스틱)
      const sentences = bodyText.split('.').filter(s => 
        s.length > 20 && 
        !s.includes('로그인') && 
        !s.includes('회원가입') &&
        !s.includes('검색')
      );
      
      content = sentences.slice(0, 10).join('.').trim();
      console.log(`⚠️ 기본 추출 사용: ${content.substring(0, 100)}...`);
    }
    
    return content || "본문을 찾을 수 없습니다.";
    
  } catch (err) {
    console.error("🔥 본문 추출 오류:", err);
    return "본문 추출 실패";
  }
}

// 📄 Firecrawl로 본문 추출 (백업용)
async function extractArticleContent(url) {
  try {
    console.log(`📖 Firecrawl로 본문 추출: ${url}`);
    
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ 
        url, 
        formats: ["markdown"],
        onlyMainContent: true,
        waitFor: 3000 // 3초 대기
      }),
    });
    
    const data = await res.json();
    const content = data?.markdown || data?.content;
    
    if (content && content.length > 100) {
      console.log(`✅ Firecrawl 본문 추출 성공: ${content.substring(0, 100)}...`);
      return content;
    } else {
      console.log("⚠️ Firecrawl 결과가 부족함, 간단 추출로 전환");
      return await extractArticleContentSimple(url);
    }
    
  } catch (err) {
    console.error("🔥 Firecrawl 본문 추출 오류:", err);
    console.log("⚠️ 간단 추출로 전환");
    return await extractArticleContentSimple(url);
  }
}

// 🤖 Claude 요약 (기존 함수 재사용)
async function summarizeWithClaude(content) {
  try {
    console.log(`🤖 Claude 요약 시작...`);
    
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

    const data = await res.json();
    const summary = data?.content?.[0]?.text ?? "요약 실패";
    
    console.log(`✅ Claude 요약 완료: ${summary.substring(0, 100)}...`);
    return summary;
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
  console.log("🚀 보안뉴스 자동 수집 시작...");
  
  const articles = await getLatestNewsFromHtml();
  
  if (articles.length === 0) {
    console.error("❌ 수집된 기사가 없습니다.");
    return;
  }

  console.log(`📊 총 ${articles.length}개 기사 처리 시작`);

  for (const { title, url } of articles) {
    console.log(`\n📰 처리 중: ${title}`);
    console.log(`🔗 URL: ${url}`);
    
    const content = await extractArticleContent(url);
    
    if (!content || content.includes("실패") || content.length < 50) {
      console.warn("⚠️ 본문이 부족하거나 없음, 건너뜀");
      continue;
    }
    
    const summary = await summarizeWithClaude(content);
    await saveToNotion({ title, summary, url });
    
    // API 호출 제한을 위해 잠시 대기
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log("✅ 전체 파이프라인 완료!");
}

// 프로그램 실행
runPipeline().catch(console.error);