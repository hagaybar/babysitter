# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## Deprecation Notice

**The VS Code extension (babysitter-vscode) has been deprecated and is no longer maintained.**

Historical release entries below are preserved for reference but the extension will not receive further updates.

---

## [Unreleased]

- No unreleased changes.


## [0.0.170] - 2026-03-02

Major release featuring a complete hook system overhaul, Docker-based deployment, harness adapter architecture for agent-agnostic compatibility, a growing process library with methodology assimilation, and many new slash commands.

Thank you for the active contributions and support: @YoavMayer , @MaTriXy , @guyelia , @Eyaldavid7 , @giladw , @yosit , @lorg , @davidt99 , @OriAshkenazi , @hexelon and others!

### Added

#### Slash Commands
- `/babysitter:doctor` — Run diagnostics
- `/babysitter:observe` — Observer dashboard for real-time process monitoring and management
- `/babysitter:yolo` — No breakpoint, fully autonomous execution mode
- `/babysitter:resume` — Resume interrupted or paused runs
- `/babysitter:help` — Usage guides for all babysitter commands and workflows, processes, skills, agents, and methodologies
- `/babysitter:plan` — Structured planning workflows
- `/babysitter:forever` — Long-running orchestration sessions
- `/babysitter:assimilate` — Convert external AI coding methodologies into babysitter process definitions, or integrate specific AI harness with the babysitter SDK (e.g. codex, opencode, antigravity)
- `/babysitter:call` — Invoke babysitter orchestration directly
- `/babysitter:project-install` and `/babysitter:user-install` — Setup and customize babysitter at project or user level

#### Core Features
- **Profiles SDK module** with CLI commands for managing user and project profiles
- **Process-driven skill and agent discovery** using JSDoc markers for better extensibility
- **Harness adapter architecture** for agent-agnostic session binding (fixes #7)
  - Claude-specific code centralized into harness adapter module
  - Auto-detection of harness environment when binding sessions
  - `--harness` flag on `run:create` for adapter selection
  - Foundation for supporting non-Claude hosts (Codex, OpenCode, etc.)
- **Session transcript capture and verification** for full orchestration lifecycle tracking
  - Structural transcript parsing for reliable stop hook verification
- **Initial prompt now persisted** in `run.json` and `RUN_CREATED` events (fixes #8)

#### Process Library
- **Methodology assimilation workflow** for converting external AI coding processes into babysitter process definitions
- **Harness integration process** — process definition for adapting the SDK to non-Claude environments
- **Codebase security audit process** for systematic security compliance scanning
- **GSD (Get Stuff Done) processes** properly converted to babysitter process definitions
- **Assimilated external methodologies**:
  - BMAD Method (bmad-code-org/BMAD-METHOD)
  - Superpowers Extended (pcvelz/superpowers)
  - Gas Town (steveyegge/gastown)
  - RPIKit (bostonaholic/rpikit)
  - CC10X (romiluz13/cc10x)
  - Metaswarm (dsifry/metaswarm)
  - and many more

#### Infrastructure
- **Docker support** as primary deployment method with comprehensive E2E testing
- **Staging publish workflow** for better release management
- **Breakpoints service and VS Code extension completely removed** from the system
- **Completion secret renamed to completion proof** throughout the API for clearer semantics

### Fixed

#### Hook System
- **Hook invocation mechanism changed** from shell scripts to SDK CLI `hook:run` command for better reliability and maintainability
- **Stop hook** no longer bails on empty prompts when run is bound to a session
- **Stop hook** now uses `last_assistant_message` fallback for better reliability
- **Stop hook skill context** improved by excluding babysit, capping at 10, showing full paths
- **Stop hook** preserves session file when run state is unknown instead of deleting it, allowing recovery
- **Stop hook** fallback run directory search for nested `.a5c/.a5c/runs/` paths created by babysit skill
- **Session-start hook** creates baseline state file proactively
- **Session-start hook** prevents hanging by ensuring clean stdin EOF handling
- **Session-start hook** installs babysitter CLI from correct SDK version

#### Breakpoints
- **Breakpoint response validation for interactive mode** — `AskUserQuestion` responses are now validated; empty or dismissed responses are no longer silently treated as approval (fixes #19)

#### State Management
- **State cache** rebuilt after terminal events ensuring data consistency

#### CLI & Build
- **CLI exit codes** properly propagated via `process.exitCode`
- **Plugin version** derived dynamically instead of being hardcoded
- **Build system fixes** including rollup workarounds and npm optional dependencies
- **Deprecated transitive dependencies** updated — resolved npm audit warnings for glob, tar, rimraf, inflight, npmlog, etc. (fixes #10)

#### Discovery & Execution
- **Discovery bloat** removed from `run:iterate` with compacted `run:create` output
- **Irrelevant specialization skills** excluded from discovery with capped summary length
- **Harness CLI flag** respected for adapter selection in `run:create`
- **Run directory resolution** improved with doubled `.a5c` path collapsing
- **Shared `resolveInputPath` utility** prevents double-nested `.a5c/runs` paths
- **Runaway loop detection threshold** increased from 3 to 10 consecutive fast iterations to reduce false positives

#### E2E & Testing
- **Session transcript format handling** fixed for real Claude Code output
- **Stop hook verification tests** made resilient to non-interactive (`-p`) mode
- **E2E orchestration tests** handle nested run directory paths with recursive search and post-run consolidation
- **E2E journal verification** allows `STOP_HOOK_INVOKED` events after `RUN_COMPLETED`
- **E2E credential handling** fixed for Azure Foundry and multiple API key formats

### Improved

#### Architecture
- **Hook system refactored** from shell scripts to SDK CLI `hook:run` command
- **Session binding** auto-configures when harness and session-id are provided
- **Discovery expanded** to agents and processes for broader capability coverage

#### Observability
- **Comprehensive diagnostic logging** throughout stop hook execution paths
- **Doctor command enhanced** with hook execution health diagnostics
- **Run verification** more resilient with better error handling and diagnostics

#### Documentation
- **Command files rewritten** with improved structure and closed process gaps
- **Assimilation documentation** for converting external methodologies and harnesses
- **Orchestration loop rules** and common mistakes clarified in SKILL.md
- **Research and plan output** improved readability (fixes #9)
- **E2E test coverage** significantly expanded for hooks, profiles, and orchestration

---


### Added
- Explorer context command `Babysitter: Dispatch Run from Task File` that trims `.task.md` content and invokes the standard dispatch flow.
- Continuous release pipeline (`.github/workflows/release.yml`) with pinned actions, checksum-protected VSIX artifacts, helper scripts for semantic versioning/release notes, and a documented rollback script (`scripts/rollback-release.sh` + `docs/release-pipeline.md`).

## [0.0.3] - 2026-01-05

### Added

- Initial packaged VS Code extension with run discovery, monitoring, UI views, and `o` integration scaffolding.
