.PHONY: setup start stop dev test build reset typecheck

setup:          ## Install / update dependencies
	./setup.sh

start:          ## Setup, then start both services in the background
	./start.sh

stop:           ## Stop both services
	./stop.sh

dev: start

test:           ## Backend acceptance tests (spec section 24)
	cd services/control-plane && .venv/bin/python -m pytest -q tests

typecheck:      ## Frontend type check
	cd apps/web && npx tsc --noEmit

build:          ## Production build of the web UI
	cd apps/web && npm run build

reset:          ## Remove local data; demo re-seeds on next start
	./scripts/reset-demo.sh
