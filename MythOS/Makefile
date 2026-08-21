SHELL := /bin/bash
.DEFAULT_GOAL := help

# MythOS v1 — build orchestration
#   make help        show this help
#   make quick       fast validate (compile + pytest + project invariants, no Docker/ISO)
#   make validate    full validation (lint + test + project invariants)
#   make package     Debian package (needs Docker)
#   make iso         hybrid live ISO (needs Docker + ~25 GiB tmp + network)
#   make smoke       UEFI boot smoke test (needs Docker + QEMU)
#   make dev         local Python venv at .venv
#   make clean       remove .build artifacts
#   make clean-all   also remove venvs and caches

VERSION := $(shell tr -d '[:space:]' < VERSION 2>/dev/null || echo "1.0.0")
PY      := python3
PIP     := pip3

# Color helpers (auto-disable if not a tty)
ifeq ($(shell test -t 1 && echo yes),yes)
  CYN := \033[36m
  GRN := \033[32m
  YLW := \033[33m
  RED := \033[31m
  DIM := \033[2m
  RST := \033[0m
else
  CYN := 
  GRN :=
  YLW :=
  RED :=
  DIM :=
  RST :=
endif

define need
	@command -v $(1) >/dev/null 2>&1 || { echo -e "$(RED)✘ missing $(1)$(RST) — $(2)"; exit 1; }
endef

.PHONY: help quick dev test lint validate package iso smoke release-update vm clean clean-all check-deps

help: ## Show this help
	@echo -e "$(CYN)━━━ MythOS $(VERSION) — make targets ━━━$(RST)"
	@echo -e " $(GRN)quick$(RST)            fast validate without ISO (compile + pytest + invariants)"
	@echo -e " $(GRN)validate$(RST)         full validation (lint + test + invariants)"
	@echo -e " $(GRN)test$(RST)             pytest unit tests"
	@echo -e " $(GRN)lint$(RST)             Python compile + shell lint (needs shellcheck for full coverage)"
	@echo -e " $(GRN)package$(RST)          build Debian package at .build/artifacts/ (needs Docker)"
	@echo -e " $(GRN)iso$(RST)              build hybrid live ISO (needs Docker + 25 GiB tmp + network)"
	@echo -e " $(GRN)smoke$(RST)            UEFI boot smoke test inside QEMU (needs Docker)"
	@echo -e " $(GRN)release-update$(RST)   in-place release bundle tar.gz (needs Docker for package)"
	@echo -e " $(GRN)vm$(RST)               VM helper (see scripts/make-vm)"
	@echo -e " $(GRN)dev$(RST)              create local Python venv at .venv (pip install -e .)"
	@echo -e " $(GRN)clean$(RST)            remove .build artifacts"
	@echo -e " $(GRN)clean-all$(RST)        also remove venvs, __pycache__, .pytest_cache"
	@echo -e " $(GRN)check-deps$(RST)       report host tool status"
	@echo ""
	@echo -e "$(DIM)Single-line install:$(RST) curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash"
	@echo -e "$(DIM)Local installer:$(RST)     bash install.sh --dry-run && bash install.sh"
	@echo -e "$(DIM)Release metadata:$(RST)    https://osaii.wyvernhub.net/mythos/release.json"
	@echo -e "$(DIM)Docs:$(RST)                docs/architecture.md  docs/security.md  docs/release-acceptance.md"
	@echo ""
	@echo -e "$(DIM)Overrides:$(RST) MYTHOS_ARCH=amd64 MYTHOS_MIRROR=https://deb.debian.org/debian make iso"
	@echo ""

check-deps: ## Report host dependency status
	@echo -e "$(CYN)━━━ host deps ━━━$(RST)"
	@command -v python3 >/dev/null 2>&1 && echo -e "$(GRN)✔$(RST) python3 $$(python3 --version 2>&1)" || echo -e "$(RED)✘$(RST) python3 missing — MythOS requires ≥3.11"
	@python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,11) else 1)' 2>/dev/null && echo -e "$(GRN)✔$(RST) python ≥3.11" || echo -e "$(YLW)▲$(RST) python <3.11 — upgrade required"
	@command -v pip3 >/dev/null 2>&1 && echo -e "$(GRN)✔$(RST) pip3 $$(pip3 --version 2>&1 | head -n1)" || echo -e "$(YLW)▲$(RST) pip3 missing — pip install -e . needs pip"
	@command -v make >/dev/null 2>&1 && echo -e "$(GRN)✔$(RST) make $$(make --version 2>&1 | head -n1)" || echo -e "$(RED)✘$(RST) make missing"
	@command -v git >/dev/null 2>&1 && echo -e "$(GRN)✔$(RST) git $$(git --version | awk '{print $$3}')" || echo -e "$(RED)✘$(RST) git missing"
	@command -v docker >/dev/null 2>&1 && echo -e "$(GRN)✔$(RST) docker $$(docker --version 2>&1 | head -n1)" || echo -e "$(YLW)▲$(RST) docker missing — package/iso/smoke will be skipped"
	@command -v shellcheck >/dev/null 2>&1 && echo -e "$(GRN)✔$(RST) shellcheck $$(shellcheck --version 2>&1 | head -n1)" || echo -e "$(YLW)▲$(RST) shellcheck missing — lint-shell will only do bash -n"
	@command -v qemu-system-x86_64 >/dev/null 2>&1 && echo -e "$(GRN)✔$(RST) qemu $$(qemu-system-x86_64 --version 2>&1 | head -n1)" || echo -e "$(YLW)▲$(RST) qemu missing — smoke tests need qemu"
	@echo -e "$(DIM)Version: $(VERSION)  Arch: $${MYTHOS_ARCH:-amd64}  Mirror: $${MYTHOS_MIRROR:-https://deb.debian.org/debian}$(RST)"

quick: ## Fast validate without ISO (compile + pytest + invariants)
	@echo -e "$(CYN)━━━ MythOS quick (no ISO) ━━━$(RST)  $(DIM)version $(VERSION)$(RST)"
	$(call need,python3,install python3 ≥3.11 — https://www.python.org or 'sudo apt install python3' on Debian/Ubuntu)
	@python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' || { echo -e "$(RED)✘ python ≥3.11 required (found $$(python3 --version 2>&1))$(RST)"; exit 1; }
	@echo -e "$(CYN)→$(RST) compile (python -m compileall)…"
	@python3 -m compileall -q src tests || { echo -e "$(RED)✘ compile failed$(RST)"; exit 1; }
	@echo -e "$(CYN)→$(RST) pytest…"
	@python3 -m pytest -q || { echo -e "$(RED)✘ pytest failed — see output above$(RST)"; echo -e "$(DIM)hint: pip install pytest or make dev$(RST)"; exit 1; }
	@echo -e "$(CYN)→$(RST) project invariants (scripts/validate-project)…"
	@python3 scripts/validate-project || { echo -e "$(RED)✘ validate-project failed — see output above$(RST)"; exit 1; }
	@echo -e "$(GRN)✔ quick passed$(RST) — $(DIM)next: make validate (full) or make package/iso (needs Docker)$(RST)"

test: ## Run pytest
	$(call need,python3,install python3 ≥3.11)
	@python3 -m pytest -q || { echo -e "$(RED)✘ pytest failed$(RST)"; echo -e "$(DIM)hint: pip install pytest  or: make dev$(RST)"; exit 1; }
	@echo -e "$(GRN)✔ tests passed$(RST)"

lint: ## Lint: compile + shell lint
	$(call need,python3,install python3 ≥3.11)
	@echo -e "$(CYN)→$(RST) python compile…"
	@python3 -m compileall -q src tests || { echo -e "$(RED)✘ Python compile failed$(RST)"; exit 1; }
	@echo -e "$(CYN)→$(RST) shell lint…"
	@./scripts/lint-shell || { echo -e "$(RED)✘ shell lint failed$(RST)"; exit 1; }
	@echo -e "$(GRN)✔ lint passed$(RST)"

validate: lint test ## Full validation (lint + test + invariants)
	@echo -e "$(CYN)→$(RST) project invariants…"
	@python3 scripts/validate-project || { echo -e "$(RED)✘ validate-project failed$(RST)"; exit 1; }
	@echo -e "$(GRN)✔ validate passed$(RST)"

package: ## Build Debian package (needs Docker)
	$(call need,docker,install docker — 'sudo apt install docker.io' on Debian/Ubuntu and ensure the daemon is running)
	@docker info >/dev/null 2>&1 || { echo -e "$(RED)✘ Docker daemon not reachable$(RST) — try 'sudo systemctl start docker' and ensure your user is in the docker group"; exit 1; }
	@echo -e "$(CYN)→$(RST) building Debian package…"
	@./scripts/build-package || { echo -e "$(RED)✘ build-package failed — see scripts/build-package output$(RST)"; exit 1; }
	@echo -e "$(GRN)✔ package built$(RST) — $(DIM)see .build/artifacts/mythos-core_*_all.deb$(RST)"

iso: ## Build hybrid live ISO (needs Docker + 25 GiB tmp + network)
	$(call need,docker,install docker — 'sudo apt install docker.io')
	@docker info >/dev/null 2>&1 || { echo -e "$(RED)✘ Docker daemon not reachable$(RST)"; exit 1; }
	@df -h . | tail -n1 | awk '{print $$4}' | xargs -I{} echo -e "$(DIM)free space: {} (need ~25 GiB for ISO)$(RST)"
	@echo -e "$(CYN)→$(RST) building hybrid ISO… (this takes a while; logs at .build/artifacts/iso-build.log)"
	@./scripts/build-iso || { echo -e "$(RED)✘ build-iso failed$(RST)"; echo -e "$(DIM)hint: ensure 25 GiB free, network to deb.debian.org, and Docker privileged mode$(RST)"; exit 1; }
	@echo -e "$(GRN)✔ ISO built$(RST) — $(DIM).build/artifacts/mythos-$(VERSION)-amd64.iso + .sha256$(RST)"

smoke: ## UEFI boot smoke test (needs Docker + QEMU)
	$(call need,docker,install docker)
	@./scripts/boot-smoke-test || { echo -e "$(RED)✘ smoke test failed$(RST)"; exit 1; }

release-update: ## Build in-place release bundle tar.gz
	@./scripts/build-release-update || { echo -e "$(RED)✘ build-release-update failed$(RST)"; exit 1; }

vm: ## VM helper
	@./scripts/make-vm || { echo -e "$(RED)✘ make-vm failed$(RST)"; exit 1; }

dev: ## Create local Python venv at .venv
	$(call need,python3,install python3 ≥3.11)
	@if [[ ! -d .venv ]]; then \
		echo -e "$(CYN)→$(RST) creating .venv…"; \
		python3 -m venv .venv || { echo -e "$(RED)✘ python3 -m venv failed — apt install python3-venv ?$(RST)"; exit 1; }; \
	else \
		echo -e "$(DIM).venv exists — refreshing$(RST)"; \
	fi
	@echo -e "$(CYN)→$(RST) pip install -e . …"
	@.venv/bin/pip install --upgrade pip setuptools -q 2>&1 | tail -n 5 || true
	@.venv/bin/pip install -e ".[dev]" 2>&1 | tail -n 20 || .venv/bin/pip install -e . 2>&1 | tail -n 20 || { echo -e "$(YLW)▲ pip install failed — try manually: source .venv/bin/activate && pip install -e .$(RST)"; exit 1; }
	@echo -e "$(GRN)✔ dev venv ready$(RST) — $(DIM)source .venv/bin/activate && mythosctl --help$(RST)"

clean: ## Remove .build artifacts
	@./scripts/clean-build || { echo -e "$(RED)✘ clean-build failed$(RST)"; exit 1; }

clean-all: clean ## Also remove venvs and caches
	@echo -e "$(CYN)→$(RST) removing venvs and caches…"
	@rm -rf .venv .mypy_cache .pytest_cache
	@find . -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
	@find . -type d -name "*.egg-info" -prune -exec rm -rf {} + 2>/dev/null || true
	@rm -rf src/mythos.egg-info src/*.egg-info 2>/dev/null || true
	@echo -e "$(GRN)✔ clean-all done$(RST)"
