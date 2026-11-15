// brief_ts: tool-calling loop. The model decides when to search (max 4 calls), then writes.
// Run: npx tsx agent.ts --company "NVIDIA" --meeting-time 2026-11-20T10:00:00+05:30
import OpenAI from "openai";

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "http://localhost:8080/v1";
const TAVILY_BASE_URL = process.env.TAVILY_BASE_URL ?? "http://localhost:8080/relay/tavily";
const MODEL = process.env.MODEL ?? "gemini/gemini-3.5-flash-lite";
const REWIND_RUN = process.env.REWIND_RUN ?? "";

const HEADERS: Record<string, string> = { "x-bf-vk": process.env.REWIND_KEY ?? "sk-bf-rewind-local" };
if (REWIND_RUN) HEADERS["x-rewind-run"] = REWIND_RUN;
// Message content can come back as a string or as a list of parts.
function textOf(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p: any) => p?.text ?? "").join("");
  return String(content);
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;
const MAX_TOOL_CALLS = 4;

// SDK retries off: we retry ourselves and never on 409 (replay divergence).
const client = new OpenAI({
  baseURL: OPENAI_BASE_URL,
  apiKey: process.env.REWIND_KEY ?? "sk-bf-rewind-local",
  defaultHeaders: HEADERS,
  maxRetries: 0,
  timeout: 120_000,
});

const SYSTEM = `You are a research assistant preparing a one-page pre-meeting briefing.
Use the web_search tool to find news about the company from the 30 days before the meeting.
Search at most ${MAX_TOOL_CALLS} times, then write the briefing in markdown with these sections:
## Recent developments
## Talking points
## Open questions
## Sources
Cite sources as markdown links with the exact URLs returned by the tool.`;

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search recent news on the web. Returns titles, URLs and snippets.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
    },
  },
];

type SearchResult = { title?: string; url?: string; content?: string; published_date?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const status: number | undefined = e?.status;
      const retryable = status === undefined ? e?.name !== "HttpError" : RETRY_STATUS.has(status);
      if (!retryable || attempt >= MAX_RETRIES) throw e;
      console.error(`[brief_ts] status ${status ?? "network"}, retry ${attempt + 1}`);
      await sleep(500 * (attempt + 1));
    }
  }
}

class HttpError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
    this.status = status;
  }
}

async function webSearch(query: string): Promise<SearchResult[]> {
  return withRetry(async () => {
    const r = await fetch(`${TAVILY_BASE_URL}/search`, {
      method: "POST",
      headers: { "content-type": "application/json", ...HEADERS },
      body: JSON.stringify({ query, topic: "news", time_range: "month", max_results: 5 }),
    });
    if (!r.ok) throw new HttpError(r.status, await r.text());
    const data: any = await r.json();
    return (data.results ?? []) as SearchResult[];
  });
}

async function run(company: string, meetingTime: string) {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Company: ${company}\nMeeting time: ${meetingTime}\nPrepare my briefing.` },
  ];
  const queries: string[] = [];
  const searchUrls: string[] = [];
  let toolCalls = 0;
  let brief = "";

  for (let turn = 0; turn < 8; turn++) {
    const allowTools = toolCalls < MAX_TOOL_CALLS;
    const resp = await withRetry(() =>
      client.chat.completions.create({
        model: MODEL,
        messages,
        temperature: 0,
        ...(allowTools ? { tools: TOOLS } : {}),
      }),
    );
    const msg = resp.choices[0].message;
    const calls = msg.tool_calls ?? [];
    if (!allowTools || calls.length === 0) {
      brief = textOf(msg.content);
      break;
    }
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let content: string;
      if (toolCalls >= MAX_TOOL_CALLS) {
        content = "Search limit reached. Write the briefing now.";
      } else {
        toolCalls++;
        let query = company;
        try {
          query = JSON.parse(call.function.arguments || "{}").query ?? company;
        } catch {}
        queries.push(query);
        try {
          const results = await webSearch(query);
          for (const r of results) if (r.url && !searchUrls.includes(r.url)) searchUrls.push(r.url);
          content = JSON.stringify(
            results.map((r) => ({ title: r.title, url: r.url, published_date: r.published_date, content: r.content })),
          );
        } catch (e: any) {
          content = `Search failed: ${e?.message ?? e}`;
        }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
  if (!brief) {
    // Out of turns: ask once more without tools.
    const resp = await withRetry(() => client.chat.completions.create({ model: MODEL, messages, temperature: 0 }));
    brief = textOf(resp.choices[0].message.content);
  }

  const cited = [...new Set(brief.match(/https?:\/\/[^\s)\]>"']+/g) ?? [])].sort();
  return {
    agent: "brief_ts",
    company,
    meeting_time: meetingTime,
    queries,
    brief,
    cited_urls: cited,
    search_urls: searchUrls,
    tool_calls: toolCalls,
  };
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

const company = arg("company");
const meetingTime = arg("meeting-time");
try {
  const result = await run(company, meetingTime);
  console.log(result.brief);
  console.log(JSON.stringify({ rewind_result: result }));
} catch (e: any) {
  console.log(JSON.stringify({ rewind_result: { agent: "brief_ts", error: `${e?.name}: ${e?.message ?? e}` } }));
  console.error(`[brief_ts] failed: ${e?.message ?? e}`);
  process.exit(1);
}
