"""Runs GPT Researcher (pip package `gpt-researcher`, unmodified) through Bifrost.

GPT Researcher reads its model settings from environment variables, so its model calls
go to Bifrost without any change. Its Tavily retriever posts to a hard-coded URL; the
only shim here points that one attribute at the Bifrost relay and adds the two gateway
headers. No GPT Researcher code is edited.
"""
import argparse
import asyncio
import json
import os

GATEWAY = os.environ.get("OPENAI_BASE_URL", "http://localhost:8080/v1")
TAVILY_BASE_URL = os.environ.get("TAVILY_BASE_URL", "http://localhost:8080/relay/tavily")
MODEL = os.environ.get("MODEL", "gemini/gemini-3.5-flash-lite")
KEY = os.environ.get("REWIND_KEY", "sk-bf-rewind-local")
HEADERS = {"x-bf-vk": KEY}
if os.environ.get("REWIND_RUN"):
    HEADERS["x-rewind-run"] = os.environ["REWIND_RUN"]

# GPT Researcher configuration, all through its documented environment variables.
os.environ.update({
    "OPENAI_BASE_URL": GATEWAY,
    "OPENAI_API_KEY": KEY,
    "TAVILY_API_KEY": "held-by-gateway",
    "RETRIEVER": "tavily",
    "FAST_LLM": f"openai:{MODEL}",
    "SMART_LLM": f"openai:{MODEL}",
    "STRATEGIC_LLM": f"openai:{MODEL}",
    "EMBEDDING": "openai:gemini/gemini-embedding-001",
    "LLM_KWARGS": json.dumps({"default_headers": HEADERS}),
    "EMBEDDING_KWARGS": json.dumps({"default_headers": HEADERS, "check_embedding_ctx_length": False}),
    "MAX_ITERATIONS": "2",
    "MAX_SEARCH_RESULTS_PER_QUERY": "5",
    "TOTAL_WORDS": "500",
    "SCRAPER_RATE_LIMIT_DELAY": "0",
})

from gpt_researcher import GPTResearcher  # noqa: E402
from gpt_researcher.retrievers.tavily import tavily_search  # noqa: E402

_orig_init = tavily_search.TavilySearch.__init__


def _init(self, *a, **kw):
    _orig_init(self, *a, **kw)
    self.base_url = f"{TAVILY_BASE_URL}/search"
    self.headers.update(HEADERS)


tavily_search.TavilySearch.__init__ = _init


class _Requests:
    """Drops the api_key field from the body so the relay's stored credential is used."""

    def __getattr__(self, name):
        import requests
        return getattr(requests, name)

    def post(self, url, data=None, **kw):
        import requests
        if isinstance(data, str):
            try:
                body = json.loads(data)
                body.pop("api_key", None)
                data = json.dumps(body)
            except ValueError:
                pass
        return requests.post(url, data=data, **kw)


tavily_search.requests = _Requests()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--company", required=True)
    ap.add_argument("--meeting-time", required=True)
    a = ap.parse_args()
    query = (f"One-page pre-meeting briefing on {a.company} for a meeting on {a.meeting_time}: "
             "developments in the last 30 days, with sections Recent developments, Talking points, "
             "Open questions and Sources.")
    r = GPTResearcher(query=query, report_type="research_report")
    await r.conduct_research()
    report = await r.write_report()
    print(report)
    print(json.dumps({"rewind_result": {"agent": "gptr", "brief": report}}))


if __name__ == "__main__":
    asyncio.run(main())
