# Holtkeeper

An automation engine for a fleet of Git repositories on GitLab and GitHub: AI code review, browserslist updates, package update propagation with refactoring, vulnerability audits, release assistance. CLI, web interface and chat bot.

Status: design. See the plan in [docs/PLAN.md](docs/PLAN.md).

Running it: one image for every role (`holtkeeper serve --role web|worker|scheduler|all`), as a single container, with Docker Compose or with the Helm chart — see [docs/deployment.md](docs/deployment.md).

Licensed under [MIT](LICENSE).
