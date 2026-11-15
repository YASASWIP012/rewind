"""Briefing agent built on LangGraph's prebuilt ReAct agent (create_react_agent).

The agent loop is LangGraph's own. Rewind only needs the base URLs and one header,
the same as the other two agents.
"""
import argparse
import json
import os

import httpx
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "http://localhost:8080/v1")
TAVILY_BASE_URL = os.environ.get("TAVILY_BASE_URL", "http://localhost:8080/relay/tavily")
MODEL = os.environ.get("MODEL", "gemini/gemini-3.5-flash-lite")
KEY = os.environ.get("REWIND_KEY", "sk-bf-rewind-local")
HEADERS = {"x-bf-vk": KEY}
if os.environ.get("REWIND_RUN"):
    HEADERS["x-rewind-run"] = os.environ["REWIND_RUN"]

http = httpx.Client(headers=HEADERS, timeout=60)


@tool
def web_search(query: str) -> str:
    """Search recent news on the web. Returns titles, URLs, dates and snippets."""
    r = http.post(f"{TAVILY_BASE_URL}/search",
                  json={"query": query, "topic": "news", "time_range": "month", "max_results": 5})
    r.raise_for_status()
    res = r.json().get("results", [])
    return json.dumps([{k: x.get(k) for k in ("title", "url", "published_date", "content")} for x in res])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--company", required=True)
    ap.add_argument("--meeting-time", required=True)
    a = ap.parse_args()
    company, meeting = a.company, a.meeting_time
    llm = ChatOpenAI(model=MODEL, base_url=OPENAI_BASE_URL, api_key=KEY, temperature=0,
                     default_headers=HEADERS, max_retries=2)
    agent = create_react_agent(llm, [web_search])
    prompt = (
        f"Prepare a one-page briefing for a meeting with {company} on {meeting}. Use web_search "
        "(at most 3 searches) for developments in the last 30 days. Write markdown with the sections "
        "## Recent developments, ## Talking points, ## Open questions and ## Sources. Cite sources as "
        "[n] with their URLs. Only state facts the search results support."
    )
    out = agent.invoke({"messages": [("user", prompt)]}, {"recursion_limit": 12})
    content = out["messages"][-1].content
    if isinstance(content, list):
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    print(content)
    print(json.dumps({"rewind_result": {"agent": "brief_lg", "brief": content}}))


if __name__ == "__main__":
    main()
