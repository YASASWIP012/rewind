// Package main is the Rewind plugin for Bifrost.
//
// Rewind records every request an agent sends through the gateway (LLM calls and
// relay calls such as Tavily search) into a cassette, replays a cassette without
// calling any provider, and forks a recorded run at step k with one mutation.
// Agents opt in by sending the header x-rewind-run.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
)

const (
	runHeader                            = "x-rewind-run"
	pendingKey schemas.BifrostContextKey = "rewind-pending-step"
)

// Config is read from the plugin's config block in Bifrost's config.json.
type Config struct {
	DataDir     string `json:"data_dir"`
	ControlAddr string `json:"control_addr"`
}

var (
	cfg   = Config{DataDir: "./data/cassettes", ControlAddr: "127.0.0.1:8099"}
	store *Store
	ctl   *controlServer
	once  sync.Once
)

// Init is called once when Bifrost loads the plugin.
func Init(config any) error {
	if config != nil {
		raw, err := json.Marshal(config)
		if err == nil {
			_ = json.Unmarshal(raw, &cfg)
		}
	}
	if v := os.Getenv("REWIND_DATA_DIR"); v != "" {
		cfg.DataDir = v
	}
	if v := os.Getenv("REWIND_CONTROL_ADDR"); v != "" {
		cfg.ControlAddr = v
	}
	var err error
	store, err = NewStore(cfg.DataDir)
	if err != nil {
		return fmt.Errorf("rewind: %w", err)
	}
	once.Do(func() {
		ctl = startControl(cfg.ControlAddr, func() *Store { return store })
	})
	return nil
}

// GetName returns the plugin's identifier.
func GetName() string { return "rewind" }

// pending carries what the pre-hook decided over to the post-hook.
type pending struct {
	run      *Run
	step     Step
	started  time.Time
	diverged *Divergence
	mu       sync.Mutex
	chunks   []json.RawMessage
	saved    bool
}

// streamBody is how a streamed response is stored in a cassette.
type streamBody struct {
	Stream bool              `json:"stream"`
	Chunks []json.RawMessage `json:"chunks"`
}

// HTTPTransportStreamChunkHook records each chunk of a live streamed chat response.
// The step is saved once the stream reports a finish reason or usage, and updated
// if more chunks follow.
func HTTPTransportStreamChunkHook(ctx *schemas.BifrostContext, req *schemas.HTTPRequest, chunk *schemas.BifrostStreamChunk) (*schemas.BifrostStreamChunk, error) {
	p, ok := ctx.Value(pendingKey).(*pending)
	if !ok || p == nil || chunk == nil || chunk.BifrostChatResponse == nil {
		return chunk, nil
	}
	raw, err := json.Marshal(chunk.BifrostChatResponse)
	if err != nil {
		return chunk, nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.chunks = append(p.chunks, raw)
	done := chunk.BifrostChatResponse.Usage != nil
	for _, c := range chunk.BifrostChatResponse.Choices {
		if c.FinishReason != nil {
			done = true
		}
	}
	if done || p.saved {
		body, _ := json.Marshal(streamBody{Stream: true, Chunks: p.chunks})
		p.step.Status = 200
		p.step.Response = body
		p.step.LatencyMS = time.Since(p.started).Milliseconds()
		if u := chunk.BifrostChatResponse.Usage; u != nil {
			p.step.Tokens = Tokens{Prompt: u.PromptTokens, Completion: u.CompletionTokens}
			p.step.CostUSD = priceFor(chunk.BifrostChatResponse.Model, p.step.Model, p.step.Tokens)
		}
		p.run.Upsert(p.step)
		p.saved = true
	}
	return chunk, nil
}

// HTTPTransportPreHook decides, per request, whether to forward it, serve it from
// the source cassette, or apply the fork mutation.
func HTTPTransportPreHook(ctx *schemas.BifrostContext, req *schemas.HTTPRequest) (*schemas.HTTPResponse, error) {
	runID := req.CaseInsensitiveHeaderLookup(runHeader)
	if runID == "" || !tracked(req.Path) {
		return nil, nil
	}
	run := store.GetOrCreate(runID)
	if run == nil {
		return nil, nil
	}
	i := run.NextIndex()
	fp, norm := Fingerprint(req.Path, req.Body)

	step := Step{
		I:           i,
		Kind:        kindOf(req.Path),
		Path:        req.Path,
		Fingerprint: fp,
		Request:     rawJSON(req.Body),
		Model:       modelOf(req.Body),
		TS:          time.Now().UTC().Format(time.RFC3339Nano),
	}
	p := &pending{run: run, step: step, started: time.Now()}

	switch {
	case run.Mode == ModeRecord:
		p.step.Source = SourceLive

	case run.Mode == ModeFork && i == run.ForkAt:
		return applyMutation(ctx, req, p)

	case run.Mode == ModeFork && i > run.ForkAt:
		p.step.Source = SourceLive

	default: // replay, or fork before the fork point
		src := run.SourceStep(i)
		if src != nil && src.Fingerprint == fp && run.Claim(src.I) {
			p.step.Source = SourceReplayed
			return serveRecorded(run, p, src)
		}
		// Concurrent requests can arrive in a different order than they were
		// recorded; serve an unused recorded step with the same fingerprint.
		if alt := run.SourceByFingerprint(fp); alt != nil {
			p.step.Source = SourceReplayed
			return serveRecorded(run, p, alt)
		}
		div := &Divergence{I: i, Got: fp}
		if src != nil {
			div.Expected = src.Fingerprint
			div.Diff = DiffJSON(src.normalized(), norm)
		} else {
			div.Diff = []FieldDiff{{Path: "(step)", Expected: "no recorded step", Got: "new request"}}
		}
		run.AddDivergence(*div)
		if run.Match == MatchStrict {
			body, _ := json.Marshal(map[string]any{
				"error": map[string]any{
					"type":    "rewind_divergence",
					"message": fmt.Sprintf("run %s diverged at step %d", run.ID, i),
					"diff":    div.Diff,
				},
			})
			p.step.Source = SourceDiverged
			p.step.Status = 409
			p.step.Response = rawJSON(body)
			run.Append(p.step)
			return jsonResponse(409, body), nil
		}
		p.step.Source = SourceDiverged
	}
	ctx.SetValue(pendingKey, p)
	return nil, nil
}

// HTTPTransportPostHook stores the live response for steps that reached a provider.
func HTTPTransportPostHook(ctx *schemas.BifrostContext, req *schemas.HTTPRequest, resp *schemas.HTTPResponse) error {
	v := ctx.Value(pendingKey)
	p, ok := v.(*pending)
	if !ok || p == nil || resp == nil {
		return nil
	}
	// Streamed responses are recorded chunk by chunk in HTTPTransportStreamChunkHook.
	p.mu.Lock()
	streamed := len(p.chunks) > 0 || isStream(req.Body)
	p.mu.Unlock()
	if streamed && resp.StatusCode < 400 {
		return nil
	}
	p.step.Status = resp.StatusCode
	p.step.Response = rawJSON(resp.Body)
	p.step.LatencyMS = time.Since(p.started).Milliseconds()
	fillUsage(&p.step, resp.Body)
	p.run.Append(p.step)
	return nil
}

// Cleanup flushes every open run. Bifrost may call it while the process keeps
// serving (for example when plugins are reloaded), so the run API stays up and
// the process exit closes it.
func Cleanup() error {
	if store != nil {
		store.FlushAll()
	}
	return nil
}

func applyMutation(ctx *schemas.BifrostContext, req *schemas.HTTPRequest, p *pending) (*schemas.HTTPResponse, error) {
	run := p.run
	m := run.Mutation
	p.step.Source = SourceMutated
	p.step.Mutation = m
	src := run.SourceStep(p.step.I)

	switch m.Type {
	case "model_swap":
		if body, err := setModel(req.Body, m.Model); err == nil {
			req.Body = body
			p.step.Request = rawJSON(body)
			p.step.Model = m.Model
		}
		ctx.SetValue(pendingKey, p)
		return nil, nil

	case "outage", "tool_error":
		status := m.Status
		if status == 0 {
			status = 503
		}
		body, _ := json.Marshal(map[string]any{"error": map[string]any{
			"type":    "rewind_injected_" + m.Type,
			"message": fmt.Sprintf("upstream unavailable (injected by rewind, HTTP %d)", status),
		}})
		p.step.Status = status
		p.step.Response = rawJSON(body)
		run.Append(p.step)
		return jsonResponse(status, body), nil

	case "poison":
		if src == nil {
			// nothing recorded to poison: forward live but still record the step
			ctx.SetValue(pendingKey, p)
			return nil, nil
		}
		body, err := poisonSearch(src.Response, m.Text)
		if err != nil {
			body = src.Response
		}
		p.step.Status = 200
		p.step.Response = rawJSON(body)
		run.Append(p.step)
		return jsonResponse(200, body), nil

	case "edit":
		body := []byte(m.Body)
		p.step.Status = 200
		p.step.Response = rawJSON(body)
		run.Append(p.step)
		return jsonResponse(200, body), nil
	}
	ctx.SetValue(pendingKey, p)
	return nil, nil
}

func serveRecorded(run *Run, p *pending, src *Step) (*schemas.HTTPResponse, error) {
	p.step.Status = src.Status
	p.step.Response = src.Response
	p.step.Tokens = src.Tokens
	p.step.ServedModel = src.ServedModel
	p.step.CostUSD = 0
	p.step.OriginalCostUSD = src.CostUSD
	p.step.LatencyMS = time.Since(p.started).Milliseconds()
	run.Append(p.step)
	status := src.Status
	if status == 0 {
		status = 200
	}
	var sb streamBody
	if json.Unmarshal(src.Response, &sb) == nil && sb.Stream {
		return sseResponse(sb.Chunks), nil
	}
	return jsonResponse(status, []byte(src.Response)), nil
}

// sseResponse replays recorded stream chunks as server-sent events.
func sseResponse(chunks []json.RawMessage) *schemas.HTTPResponse {
	var b strings.Builder
	for _, c := range chunks {
		b.WriteString("data: ")
		b.Write(c)
		b.WriteString("\n\n")
	}
	b.WriteString("data: [DONE]\n\n")
	return &schemas.HTTPResponse{
		StatusCode: 200,
		Headers:    map[string]string{"Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Rewind": "1"},
		Body:       []byte(b.String()),
	}
}

func jsonResponse(status int, body []byte) *schemas.HTTPResponse {
	return &schemas.HTTPResponse{
		StatusCode: status,
		Headers:    map[string]string{"Content-Type": "application/json", "X-Rewind": "1"},
		Body:       body,
	}
}

func tracked(path string) bool {
	return strings.HasPrefix(path, "/v1/chat/completions") ||
		strings.HasPrefix(path, "/v1/responses") ||
		strings.HasPrefix(path, "/relay/")
}

func kindOf(path string) string {
	if strings.HasPrefix(path, "/relay/") {
		return "relay"
	}
	return "llm"
}
