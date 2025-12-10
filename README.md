## Claude Library 

A pretty simple local web tool to watch for Claude projects markdown files and organize them for better reading and browsing

### Prerequisites

- Python 3.12+
- Astral [uv](https://docs.astral.sh/uv/getting-started/installation/) 

### Installation

```
uv sync
```

### Usage

Run the local web server

```
uv run -m http.server 7777
```

Run sync watcher

```
# watch the given project folder to watch for md files and sync to the local folder
uv run watch.py ../MyClaudeProject --mirror-to ./md --max-depth 3
```

Open your browser at http://localhost:7777
