package main

import (
	"strings"
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
)

func streamChunk(text string, finish bool) *schemas.BifrostStreamChunk {
	c := schemas.BifrostResponseChoice{Index: 0}
	if finish {
		r := "stop"
		c.FinishReason = &r
	}
	resp := &schemas.BifrostChatResponse{ID: "x", Object: "chat.completion.chunk", Model: "gemini-3.5-flash-lite", Choices: []schemas.BifrostResponseChoice{c}}
	if finish {
		resp.Usage = &schemas.BifrostLLMUsage{PromptTokens: 10, CompletionTokens: 5}
	}
	_ = text
	return &schemas.BifrostStreamChunk{BifrostChatResponse: resp}
}

func TestStreamRecordAndReplayAsSSE(t *testing.T) {
	store.Open(RunSpec{RunID: "stream-base", Mode: "record"})
	body := `{"model":"gemini/gemini-3.5-flash-lite","stream":true,"messages":[{"role":"user","content":"hi"}]}`
	resp, ctx, req := send(t, "stream-base", chatPath, body)
	if resp != nil {
		t.Fatal("record must forward")
	}
	for i, fin := range []bool{false, false, true} {
		out, err := HTTPTransportStreamChunkHook(ctx, req, streamChunk("t", fin))
		if err != nil || out == nil {
			t.Fatalf("chunk %d: %v", i, err)
		}
	}
	base := loadRun(t, "stream-base")
	if len(base.Steps) != 1 || !strings.Contains(string(base.Steps[0].Response), `"stream":true`) {
		t.Fatalf("stream step not recorded: %+v", base.Steps)
	}
	if base.Steps[0].Tokens.Prompt != 10 || base.Steps[0].Tokens.Completion != 5 {
		t.Fatalf("usage not captured: %+v", base.Steps[0].Tokens)
	}

	store.Open(RunSpec{RunID: "stream-replay", Mode: "replay", Source: "stream-base", Match: "strict"})
	resp, _, _ = send(t, "stream-replay", chatPath, body)
	if resp == nil || resp.Headers["Content-Type"] != "text/event-stream" {
		t.Fatalf("replay must answer as SSE: %+v", resp)
	}
	out := string(resp.Body)
	if strings.Count(out, "data: ") != 4 || !strings.HasSuffix(out, "data: [DONE]\n\n") {
		t.Fatalf("SSE body = %q", out)
	}
}
