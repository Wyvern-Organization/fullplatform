SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help install setup check-env dev dev-studio test test-all typecheck lint build deploy-dry db-migrate db-migrate-local clean

help: ## Show this help
	@grep -E '^[a-zA-Z0-9:._-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n",$$1,$$2}'

install: ## Full setup: deps + .dev.vars + env check + D1 dry-run
	bash scripts/setup.sh

setup: install ## Alias for install

check-env: ## Validate .dev.vars
	bash scripts/check-env.sh

dev: ## Run Worker on :8787
	npx wrangler dev --config wrangler.jsonc

dev-studio: ## Run Worker on :8788
	npx wrangler dev --config wrangler.jsonc --port 8788

test: ## Node contract tests
	node --test tests/*.test.mjs

test-all: ## Node + cargo + MythOS pytest + typecheck
	bash scripts/test-all.sh

typecheck: ## tsc --noEmit
	npx tsc --noEmit

lint: ## tsc lint
	npx tsc --noEmit --pretty false 2>&1 | head -n 100; echo "lint done"

build: ## wrangler deploy --dry-run
	npx wrangler deploy --dry-run --config wrangler.jsonc

deploy-dry: build ## Alias for build

db-migrate: ## Apply D1 migrations (remote)
	npx wrangler d1 migrations apply osaii --config wrangler.jsonc

db-migrate-local: ## Apply D1 migrations locally
	npx wrangler d1 migrations apply osaii --local --config wrangler.jsonc

clean: ## Remove build artifacts & caches
	rm -rf .wrangler node_modules/.cache dist MythOS/.build
	@echo "clean done"
