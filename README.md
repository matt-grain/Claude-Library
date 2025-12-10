## Claude Library 

### Prerequisites

- Python 3.12+
- Astral uv

### Installation

```
uv sync
```

### Usage

Run web server

```
uv run -m http.server 7777
```

Run sync watcher

```
uv run watch.py ../MyClaudeProject --mirror-to ./md --max-depth 3
```
