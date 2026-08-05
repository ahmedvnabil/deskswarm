# deskswarm — the handful of commands you actually run.
# Everything here is a thin wrapper over docker compose; nothing is required.

COMPOSE ?= docker compose
PORT    ?= 7861
# Point check/doctor/backup at another host: make doctor HOST=192.168.1.50
HOST    ?= localhost

.DEFAULT_GOAL := help

.PHONY: help up down restart logs shell test check backup doctor clean

help:  ## show this help
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk -F':.*?## ' '{printf "  \033[1m%-10s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "  dashboard: http://$(HOST):$(PORT)"

up:  ## build and start the dashboard (no configuration needed)
	$(COMPOSE) up -d --build
	@echo
	@echo "  deskswarm is starting on http://$(HOST):$(PORT)"
	@echo "  the first machine you add also builds the agent bridge — give it a minute"

down:  ## stop the dashboard (machines and their files are untouched)
	$(COMPOSE) down

restart:  ## rebuild and restart after changing the code
	$(COMPOSE) up -d --build

logs:  ## follow the dashboard log
	$(COMPOSE) logs -f dashboard

shell:  ## a shell inside the dashboard container
	$(COMPOSE) exec dashboard bash

test:  ## run the test suite (needs: pip install flask docker requests pytest)
	pytest tests -q

check:  ## is it up?
	@curl -fsS http://$(HOST):$(PORT)/health && echo || \
		{ echo "  no answer on :$(PORT) — try 'make logs'"; exit 1; }

backup:  ## back up every machine's home directory now
	@curl -fsS http://$(HOST):$(PORT)/api/v1/computers \
		| python3 -c 'import json,sys;[print(c["id"]) for c in json.load(sys.stdin)["data"]]' \
		| while read id; do \
			curl -fsS -X POST http://$(HOST):$(PORT)/api/v1/computers/$$id/backups \
			| python3 -c 'import json,sys;d=json.load(sys.stdin)["data"];print("  ",d["machine"],d["name"],str(round(d["bytes"]/1e6,1))+" MB")'; \
		done

doctor:  ## check the things that usually go wrong
	@echo "docker:"; docker version --format '  {{.Server.Version}}' 2>/dev/null || echo "  NOT REACHABLE"
	@echo "compose:"; $(COMPOSE) version --short 2>/dev/null | sed 's/^/  /' || echo "  NOT FOUND"
	@# Assigned, not piped: a pipeline's exit status is the last command's, so
	@# `curl ... | sed || echo` reports success even when curl failed.
	@echo "dashboard:"; out=$$(curl -fsS http://$(HOST):$(PORT)/health 2>/dev/null) \
		&& echo "  $$out" || echo "  not running on :$(PORT) — 'make up'"
	@# No f-string here: escaped quotes inside one are a syntax error before
	@# Python 3.12, and this silently printed "n/a" because of it.
	@echo "guards:"; curl -fsS http://$(HOST):$(PORT)/api/v1/guards 2>/dev/null \
		| python3 -c 'import json,sys;g=json.load(sys.stdin)["data"];print("  %s MB free (%s), %s GB disk" % (g["memory_available_mb"], g["memory_source"], g["disk_free_gb"]));[print("  !",w) for w in g["warnings"]+g["blocking"]]' 2>/dev/null || echo "  n/a"
	@echo "apparmor:"; grep -q apparmor /sys/kernel/security/lsm 2>/dev/null \
		&& echo "  enabled — if machines fail to start, set DESKSWARM_DISABLE_APPARMOR=1" \
		|| echo "  not enforced"

clean:  ## remove the dashboard AND every machine, volume and backup
	@echo "This deletes every machine, its home volume, and all backups."
	@read -p "Type 'yes' to continue: " a; [ "$$a" = yes ] || exit 1
	-docker rm -f $$(docker ps -aq --filter 'label=deskswarm.slug') 2>/dev/null
	-docker volume rm $$(docker volume ls -q --filter 'name=deskswarm-dyn-home-') 2>/dev/null
	$(COMPOSE) down -v
