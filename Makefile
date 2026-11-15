BIFROST_VERSION := v2.5.1
ENV_FILE ?= ../.env

.PHONY: build plugin gateway run test viewer

build: gateway plugin

# The published transports module embeds the dashboard UI, which the module
# proxy does not ship. Copy it locally with an empty UI so it compiles.
build/transports:
	cd plugin && go mod download github.com/maximhq/bifrost/transports/v2@$(BIFROST_VERSION)
	mkdir -p build
	cp -R $$(go env GOMODCACHE)/github.com/maximhq/bifrost/transports/v2@$(BIFROST_VERSION) build/transports
	chmod -R u+w build/transports
	mkdir -p build/transports/bifrost-http/ui
	echo '<!doctype html><title>Bifrost</title>' > build/transports/bifrost-http/ui/index.html

# A dynamically linked Bifrost binary, built from the same module graph as the
# plugin so their shared packages match exactly.
gateway: build/transports
	cd plugin && CGO_ENABLED=1 go build -ldflags="-w -s" -o ../bin/bifrost-http github.com/maximhq/bifrost/transports/v2/bifrost-http

plugin: build/transports
	cd plugin && CGO_ENABLED=1 go build -buildmode=plugin -o ../bin/rewind.so .

test:
	cd plugin && go test ./...

# Starts Bifrost with the Rewind plugin on :8080 (control API on :8099).
run: build
	mkdir -p data/cassettes
	set -a; [ -f $(ENV_FILE) ] && . $(ENV_FILE); set +a; \
	./bin/bifrost-http -app-dir gateway -port 8080 -log-style pretty

viewer:
	cd web && python3 -m http.server 4173
