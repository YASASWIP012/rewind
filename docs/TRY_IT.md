# Try Rewind in about 10 minutes

You need macOS or Linux, Go 1.27+, Node 24, Python 3.15 with `uv`, and two free API keys: Gemini (aistudio.google.com/apikey) and Tavily (app.tavily.com).

1. Clone and add your keys. The file sits next to the repo, so it never gets committed.

   ```bash
   git clone https://github.com/YASASWIP012/rewind && cd rewind
   printf 'GEMINI_API_KEY=your-key\nTAVILY_API_KEY=your-key\n' > ../.env
   ```

2. Start the gateway. The first build takes a few minutes.

   ```bash
   make run
   ```

   Wait for `plugin status: rewind - active`.

3. In a second terminal, record one agent and then replay it:

   ```bash
   cd bench
   uv run python rewind_bench.py record --agents brief_py --tasks nvidia
   uv run python rewind_bench.py replay --agents brief_py --tasks nvidia
   ```

   The replay row shows the original cost and time next to the replay's.

4. Fork it. This plants a false claim in one search result and reruns the agent from that point:

   ```bash
   uv run python rewind_bench.py fork --agents brief_py --tasks nvidia --repeats 1 --no-model-swap
   uv run python rewind_bench.py report
   ```

5. Open the viewer and look at the run tree and the branch diff:

   ```bash
   cd ../web && python3 -m http.server 4173
   ```

   Then go to http://localhost:4173.

6. Try it on your own agent. Point its OpenAI-compatible base URL at `http://localhost:8080/v1`, send the header `x-bf-vk: sk-bf-rewind-local` and a header `x-rewind-run: my-first-run`, and run it once. Your run shows up at `http://localhost:8099/rewind/runs/my-first-run`.

If something breaks, the gateway log is in `data/gateway.log`. We'd like to hear what you tried and what happened, good or bad.
