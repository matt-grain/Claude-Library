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
# whhich Claude project folder to watch and sync
uv run watch.py ../MyClaudeProject --mirror-to ./md --max-depth 3
```
