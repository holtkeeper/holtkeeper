.PHONY: build test lint

build:
	go build ./cmd/widgets

test:
	go test ./...

lint:
	golangci-lint run
