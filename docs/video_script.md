# Demo video script (about 2 minutes)

Each block is one scene. The narration is what gets voiced; the screen line says what's shown.

## 1. The problem (0:00 to 0:15)
Screen: two runs of the same agent side by side, different steps.

> Run the same AI agent twice and you get two different runs. Different searches, different calls, a different answer. So when you change something, you can't tell your change apart from luck.

## 2. The idea (0:15 to 0:30)
Screen: architecture slide, the gateway in the middle.

> Every model call and every web search an agent makes already goes through the Bifrost gateway. So we built Rewind, a Bifrost plugin that records a run step by step, replays it, and lets you fork it.

## 3. Record and replay (0:30 to 0:50)
Screen: the viewer overview, replay panel.

> Here are two briefing agents, one in Python and one in TypeScript. Neither has any Rewind code; they just point at Bifrost. We recorded both on real companies. Replaying a run answers every request from the recording, so it costs nothing and it's the same run every time.

## 4. Fork (0:50 to 1:20)
Screen: run tree, then the branch diff at the fork point.

> Forking is the part we care about. Rewind replays the first steps exactly, then changes one thing. Here we slip a false acquisition claim into one search result. Because both branches share the same history, the only difference is that one search result, and you can see where the agent took it in.

## 5. Results (1:20 to 1:45)
Screen: results table.

> {{RESULT_LINE}}

## 6. For developers (1:45 to 2:05)
Screen: terminal running the test command, then the upstream pull request.

> A recorded run is also a free regression test: change a prompt and Rewind tells you the step and the field that changed. The plugin runs on a stock Bifrost build, has thirty-six tests, and we've opened it as a pull request to Bifrost.

## 7. Close (2:05 to 2:15)
Screen: the demo link.

> Rewind. Record, replay and fork any agent run at the gateway. The demo is live, no keys needed.
