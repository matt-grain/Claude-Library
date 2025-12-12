<p align="center">
  <img src="https://img.shields.io/badge/python-3.13+-blue?style=for-the-badge&logo=python&logoColor=white" alt="Python 3.13+">
  <img src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge" alt="MIT License">
  <img src="https://img.shields.io/badge/platform-windows%20%7C%20linux%20%7C%20macos-lightgrey?style=for-the-badge" alt="Platform">
</p>

<h1 align="center">
  📚 Claude Library
</h1>

<p align="center">
  <strong>A beautiful real-time markdown file watcher with live TUI dashboard</strong>
</p>

<p align="center">
  Watch your Claude projects, sync markdown files, and browse them in style.<br>
  All from a single command with a gorgeous terminal interface.
</p>

---

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 📁 MD SYNC  •  Markdown File Watcher                                         │
└──────────────────────────────────────────────────────────────────────────────┘
┌─ Configuration ──────────────┐ ┌─ Activity ───────────────────────────────────┐
│ Watch   C:\Projects\MyProject│ │ 14:32:15 ● modified  docs/README.md          │
│ Mirror  C:\Projects\MD\md    │ │ 14:32:15 ◆ index     142 files               │
│ Index   files.json           │ │ 14:31:02 ✚ created   notes/todo.md           │
│ Server  http://localhost:7777│ │ 14:30:45 ↓ sync      docs/api.md             │
├─ Statistics ─────────────────┤ │ 14:30:44 ✖ deleted   old/deprecated.md       │
│ Files in Index          142  │ │ 14:30:43 → moved     drafts/idea.md          │
│ Files Synced             87  │ │                                              │
│ Events                   23  │ │                                              │
│ Uptime            00:05:32   │ │                                              │
└──────────────────────────────┘ └──────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● Watching for changes...  •  Last: 3s ago                                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

## ✨ Features

- 🖥️ **Live TUI Dashboard** — Beautiful real-time terminal interface powered by [Rich](https://github.com/Textualize/rich)
- 🔄 **Smart File Sync** — Watches your project and mirrors `.md` files with intelligent debouncing
- 🌐 **Embedded Web Server** — Browse your markdown files in the browser, no extra process needed
- ⚡ **Concurrent-Safe** — Handles file locks gracefully when other tools are editing
- 🎨 **Color-Coded Events** — Instantly see creates, modifies, deletes, and moves
- 📊 **Real-Time Stats** — Track synced files, events, uptime, and errors
- 🚀 **Zero Config** — Just point it at your project and go

## 🚀 Quick Start

### Prerequisites

- Python 3.13+
- [uv](https://docs.astral.sh/uv/getting-started/installation/) (recommended) or pip

### Installation

```bash
git clone https://github.com/yourusername/claude-library.git
cd claude-library
uv sync
```

### Usage

```bash
# Watch a project and start the web server
uv run watch.py /path/to/your/claude-project

# Open in browser
open http://localhost:7777
```

That's it! The dashboard will show you everything in real-time.

## 📖 Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `watch_dir` | — | `.` | Directory to watch for `.md` files |
| `--mirror-to` | — | `./md` | Local directory to sync files into |
| `--out` | `-o` | `files.json` | Output index file |
| `--port` | `-p` | `7777` | HTTP server port |
| `--max-depth` | — | unlimited | Limit directory recursion depth |
| `--prune` | — | off | Remove stale files from mirror |
| `--no-tui` | — | off | Simple logging instead of TUI |
| `--no-server` | — | off | Disable embedded HTTP server |

### Examples

```bash
# Basic usage - watch project, sync to ./md, serve on :7777
uv run watch.py ../MyProject

# Custom port and limited depth (useful for large projects)
uv run watch.py ../MyProject --port 8080 --max-depth 3

# Sync only, no web server
uv run watch.py ../MyProject --no-server

# Clean mode - remove files that no longer exist in source
uv run watch.py ../MyProject --prune

# Headless mode for CI/scripts
uv run watch.py ../MyProject --no-tui
```

## 🎯 Event Types

The dashboard shows different event types with distinct icons:

| Icon | Event | Description |
|------|-------|-------------|
| ✚ | `created` | New file added |
| ● | `modified` | File content changed |
| ✖ | `deleted` | File removed |
| → | `moved` | File renamed/moved |
| ↓ | `sync` | Initial sync copy |
| ◆ | `index` | Index regenerated |
| ✂ | `prune` | Stale file removed |
| ◌ | `skip` | File locked, will retry |

## 🏗️ Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Source Project │────▶│   Watcher    │────▶│  Mirror (./md)  │
│  (your files)   │     │  (watchdog)  │     │  (local copy)   │
└─────────────────┘     └──────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────┐
                        │  files.json  │
                        │   (index)    │
                        └──────────────┘
                               │
                               ▼
                        ┌──────────────┐     ┌─────────────────┐
                        │  Web Server  │────▶│    Browser      │
                        │   (:7777)    │     │  (index.html)   │
                        └──────────────┘     └─────────────────┘
```

## 🛠️ Development

```bash
# Install dev dependencies
uv sync

# Run linting
uv run ruff check watch.py

# Run type checking
uv run pyright watch.py

# Run security scan
uv run bandit watch.py

# Format code
uv run ruff format watch.py
```

## 📄 License

MIT License - do whatever you want with it.

---

<p align="center">
  Made with ☕ and 🤖 by humans and Claude
</p>
