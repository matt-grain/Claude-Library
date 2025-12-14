#!/usr/bin/env python3
"""
watch.py - Markdown File Watcher with Live Dashboard and Web Server

Watches a directory recursively for added/modified/deleted .md files and regenerates
files.json (a JSON array of relative paths). Mirrors changed files into a local
directory preserving relative paths. Includes an embedded HTTP server for browsing.

Usage:
    python watch.py [watch_dir] [--out files.json] [--mirror-to ./md] [--port 7777]
"""

import sys
import os
import json
import time
import threading
import argparse
import shutil
import socketserver
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from typing import Optional
from datetime import datetime
from collections import deque
from dataclasses import dataclass, field

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileSystemEvent

from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich.layout import Layout
from rich.style import Style


# --- Configuration ---
DEBOUNCE_SECONDS = 1.0  # Longer debounce to let writes complete
COPY_RETRY_ATTEMPTS = 5
COPY_RETRY_DELAY = 0.3  # 300ms between retries
COPY_INITIAL_DELAY = 0.2  # Wait before first copy attempt
SKIP_DIRS = {"__pycache__", ".git", ".venv", "node_modules"}
MAX_ACTIVITY_LOG = 12
DEFAULT_PORT = 7777


# --- Styles ---
STYLE_HEADER = Style(color="white", bold=True)
STYLE_CREATED = Style(color="green")
STYLE_MODIFIED = Style(color="yellow")
STYLE_DELETED = Style(color="red")
STYLE_MOVED = Style(color="cyan")
STYLE_ERROR = Style(color="red", bold=True)
STYLE_DIM = Style(color="bright_black")
STYLE_SUCCESS = Style(color="green", bold=True)


# --- HTTP Server ---
class QuietHTTPHandler(SimpleHTTPRequestHandler):
    """HTTP handler that suppresses all logging."""

    def log_message(self, format: str, *args: object) -> None:
        pass  # Suppress all output


class WebServer:
    """Embedded HTTP server running in a background thread."""

    def __init__(self, directory: Path, port: int = DEFAULT_PORT):
        self.directory = directory
        self.port = port
        self.server: Optional[socketserver.TCPServer] = None
        self.thread: Optional[threading.Thread] = None

    def start(self) -> bool:
        """Start the server. Returns True if successful."""
        try:
            socketserver.TCPServer.allow_reuse_address = True

            # Create handler class with directory bound
            directory = str(self.directory)

            class Handler(QuietHTTPHandler):
                def __init__(self, *args: object, **kwargs: object) -> None:
                    super().__init__(*args, directory=directory, **kwargs)  # type: ignore[arg-type]

            self.server = socketserver.TCPServer(("", self.port), Handler)

            self.thread = threading.Thread(
                target=self.server.serve_forever, daemon=True
            )
            self.thread.start()
            return True
        except OSError:
            return False

    def stop(self) -> None:
        """Stop the server."""
        if self.server:
            self.server.shutdown()
            self.server = None

    @property
    def url(self) -> str:
        return f"http://localhost:{self.port}"


# --- Dashboard ---
@dataclass
class Stats:
    """Statistics for the dashboard."""

    files_in_index: int = 0
    files_synced: int = 0
    files_pruned: int = 0
    events_processed: int = 0
    errors: int = 0
    start_time: datetime = field(default_factory=datetime.now)
    last_event_time: Optional[datetime] = None


@dataclass
class ActivityEntry:
    """A single activity log entry."""

    timestamp: datetime
    event_type: str
    path: str
    error: Optional[str] = None


class Dashboard:
    """Live TUI dashboard for the file watcher."""

    def __init__(
        self,
        watch_root: Path,
        mirror_to: Optional[Path],
        index_path: Path,
        server_url: Optional[str] = None,
    ):
        self.watch_root = watch_root
        self.mirror_to = mirror_to
        self.index_path = index_path
        self.server_url = server_url
        self.stats = Stats()
        self.activity: deque[ActivityEntry] = deque(maxlen=MAX_ACTIVITY_LOG)
        self.status = "Initializing..."
        self.status_style = STYLE_DIM
        self._lock = threading.Lock()
        self.console = Console()

    def set_status(self, status: str, style: Style = STYLE_DIM) -> None:
        with self._lock:
            self.status = status
            self.status_style = style

    def log_activity(
        self, event_type: str, path: str, error: Optional[str] = None
    ) -> None:
        with self._lock:
            self.activity.appendleft(
                ActivityEntry(
                    timestamp=datetime.now(),
                    event_type=event_type,
                    path=path,
                    error=error,
                )
            )
            self.stats.last_event_time = datetime.now()
            self.stats.events_processed += 1
            if error:
                self.stats.errors += 1

    def update_index_count(self, count: int) -> None:
        with self._lock:
            self.stats.files_in_index = count

    def increment_synced(self, count: int = 1) -> None:
        with self._lock:
            self.stats.files_synced += count

    def increment_pruned(self, count: int = 1) -> None:
        with self._lock:
            self.stats.files_pruned += count

    def _make_header(self) -> Panel:
        """Create the header panel."""
        title = Text()
        title.append("📁 ", style="bold")
        title.append("MD SYNC", style="bold cyan")
        title.append("  •  ", style="dim")
        title.append("Markdown File Watcher", style="dim italic")
        return Panel(title, style="cyan", padding=(0, 2))

    def _make_config_table(self) -> Table:
        """Create the configuration display."""
        table = Table(show_header=False, box=None, padding=(0, 2))
        table.add_column("Key", style="bold blue")
        table.add_column("Value", style="white")

        table.add_row("Watch", str(self.watch_root))
        table.add_row("Mirror", str(self.mirror_to) if self.mirror_to else "—")
        table.add_row("Index", str(self.index_path))
        if self.server_url:
            table.add_row("Server", Text(self.server_url, style="bold cyan underline"))

        return table

    def _make_stats_table(self) -> Table:
        """Create the statistics display."""
        table = Table(show_header=False, box=None, padding=(0, 2))
        table.add_column("Key", style="bold magenta")
        table.add_column("Value", style="white", justify="right")

        uptime = datetime.now() - self.stats.start_time
        hours, remainder = divmod(int(uptime.total_seconds()), 3600)
        minutes, seconds = divmod(remainder, 60)

        with self._lock:
            table.add_row("Files in Index", str(self.stats.files_in_index))
            table.add_row("Files Synced", str(self.stats.files_synced))
            table.add_row("Events", str(self.stats.events_processed))
            if self.stats.errors > 0:
                table.add_row("Errors", Text(str(self.stats.errors), style=STYLE_ERROR))
            table.add_row("Uptime", f"{hours:02d}:{minutes:02d}:{seconds:02d}")

        return table

    def _make_activity_panel(self) -> Panel:
        """Create the activity log panel."""
        if not self.activity:
            content = Text("Waiting for changes...", style=STYLE_DIM, justify="center")
            return Panel(
                content,
                title="[bold]Activity[/bold]",
                border_style="blue",
                padding=(1, 2),
            )

        lines = []
        with self._lock:
            for entry in self.activity:
                line = Text()

                # Timestamp
                ts = entry.timestamp.strftime("%H:%M:%S")
                line.append(f"{ts} ", style=STYLE_DIM)

                # Event type with icon and color
                event_styles = {
                    "created": ("✚", STYLE_CREATED),
                    "modified": ("●", STYLE_MODIFIED),
                    "deleted": ("✖", STYLE_DELETED),
                    "moved": ("→", STYLE_MOVED),
                    "sync": ("↓", STYLE_SUCCESS),
                    "prune": ("✂", STYLE_DELETED),
                    "index": ("◆", Style(color="blue")),
                    "skip": ("◌", STYLE_DIM),  # Skipped due to lock
                    "error": ("⚠", STYLE_ERROR),
                }
                icon, style = event_styles.get(entry.event_type, ("•", STYLE_DIM))
                line.append(f"{icon} ", style=style)
                line.append(f"{entry.event_type:8} ", style=style)

                # Path (truncated if needed)
                max_path_len = 50
                path = entry.path
                if len(path) > max_path_len:
                    path = "..." + path[-(max_path_len - 3) :]
                line.append(path)

                # Error message if present
                if entry.error:
                    line.append(f" ({entry.error})", style=STYLE_ERROR)

                lines.append(line)

        return Panel(
            Group(*lines) if lines else Text("No activity", style=STYLE_DIM),
            title="[bold]Activity[/bold]",
            border_style="blue",
            padding=(0, 1),
        )

    def _make_status_bar(self) -> Panel:
        """Create the status bar."""
        with self._lock:
            status_text = Text()
            status_text.append("● ", style=self.status_style)
            status_text.append(self.status, style=self.status_style)

            # Last event time
            if self.stats.last_event_time:
                ago = (datetime.now() - self.stats.last_event_time).total_seconds()
                if ago < 60:
                    ago_str = f"{int(ago)}s ago"
                elif ago < 3600:
                    ago_str = f"{int(ago / 60)}m ago"
                else:
                    ago_str = f"{int(ago / 3600)}h ago"
                status_text.append("  •  ", style=STYLE_DIM)
                status_text.append(f"Last: {ago_str}", style=STYLE_DIM)

        return Panel(status_text, style="dim", padding=(0, 2))

    def render(self) -> Layout:
        """Render the full dashboard."""
        layout = Layout()

        layout.split_column(
            Layout(name="header", size=3),
            Layout(name="body"),
            Layout(name="status", size=3),
        )

        layout["header"].update(self._make_header())

        # Body split into left (config + stats) and right (activity)
        layout["body"].split_row(
            Layout(name="left", ratio=1),
            Layout(name="right", ratio=2),
        )

        left_content = Group(
            Panel(
                self._make_config_table(),
                title="[bold]Configuration[/bold]",
                border_style="green",
            ),
            Panel(
                self._make_stats_table(),
                title="[bold]Statistics[/bold]",
                border_style="magenta",
            ),
        )
        layout["left"].update(left_content)
        layout["right"].update(self._make_activity_panel())
        layout["status"].update(self._make_status_bar())

        return layout


# --- File utilities ---
def should_include_dir(dirname: str) -> bool:
    """Check if a directory should be included in scanning."""
    if dirname in SKIP_DIRS:
        return False
    if dirname.startswith(".claude"):
        return True
    if dirname.startswith("."):
        return False
    return True


def should_include_path(rel_path: Path) -> bool:
    """Check if a relative path should be included (not in hidden dirs except .claude)."""
    parts = rel_path.parts
    for part in parts[:-1]:
        if part.startswith(".") and not part.startswith(".claude"):
            return False
    return True


def is_md_file(path: Path | str) -> bool:
    """Check if a path is a markdown file."""
    return str(path).lower().endswith(".md")


def walk_md_files(
    root: Path, max_depth: Optional[int] = None, exclude_dir: Optional[Path] = None
):
    """Generator that yields (relative_path, full_path) for all .md files.

    Args:
        root: Root directory to walk
        max_depth: Optional maximum recursion depth
        exclude_dir: Optional directory to exclude from scanning (e.g., mirror dir)
    """
    # Resolve exclude_dir for comparison
    exclude_resolved = exclude_dir.resolve() if exclude_dir else None

    for dirpath, dirnames, filenames in os.walk(root):
        current_path = Path(dirpath).resolve()

        # Skip the excluded directory entirely
        if exclude_resolved and (
            current_path == exclude_resolved
            or exclude_resolved in current_path.parents
        ):
            dirnames.clear()
            continue

        rel_dir = Path(dirpath).relative_to(root)
        depth = len(rel_dir.parts) if str(rel_dir) != "." else 0

        if max_depth is not None and depth >= max_depth:
            dirnames.clear()
            continue

        # Filter out excluded directory from dirnames to prevent descent
        if exclude_resolved:
            dirnames[:] = [
                d for d in dirnames
                if should_include_dir(d)
                and (current_path / d).resolve() != exclude_resolved
            ]
        else:
            dirnames[:] = [d for d in dirnames if should_include_dir(d)]

        for fname in sorted(filenames):
            if not is_md_file(fname):
                continue
            full_path = Path(dirpath) / fname
            rel_path = full_path.relative_to(root)
            if should_include_path(rel_path):
                yield rel_path, full_path


def build_index(
    root: Path, max_depth: Optional[int] = None, exclude_dir: Optional[Path] = None
) -> list[str]:
    """Build sorted index of .md file paths."""
    return sorted(
        str(rel.as_posix()) for rel, _ in walk_md_files(root, max_depth, exclude_dir)
    )


def write_index(
    root: Path,
    out_path: Path,
    max_depth: Optional[int] = None,
    dashboard: Optional[Dashboard] = None,
    exclude_dir: Optional[Path] = None,
) -> int:
    """Write the index to a JSON file atomically. Returns file count."""
    md_paths = build_index(root, max_depth, exclude_dir)
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    tmp.write_text(json.dumps(md_paths, indent=2, ensure_ascii=False))
    tmp.replace(out_path)

    if dashboard:
        dashboard.update_index_count(len(md_paths))
        dashboard.log_activity("index", f"{len(md_paths)} files")

    return len(md_paths)


def is_file_stable(path: Path, wait: float = 0.1) -> bool:
    """Check if a file is stable (not being written to) by comparing sizes."""
    try:
        if not path.exists() or not path.is_file():
            return False
        size1 = path.stat().st_size
        time.sleep(wait)
        size2 = path.stat().st_size
        return size1 == size2
    except OSError:
        return False


def copy_file_with_retry(
    src: Path, dst: Path, retries: int = COPY_RETRY_ATTEMPTS
) -> bool:
    """
    Copy a file with retry logic for handling locked/in-use files.

    Waits for file to be stable before copying to avoid partial reads
    when another process is writing to the file.
    """
    # Initial delay to let any write operation start
    time.sleep(COPY_INITIAL_DELAY)

    dst.parent.mkdir(parents=True, exist_ok=True)

    for attempt in range(retries):
        try:
            # Check if file exists and is not being written to
            if not src.exists() or not src.is_file():
                return False

            # Wait for file to be stable (size not changing)
            if not is_file_stable(src):
                if attempt < retries - 1:
                    time.sleep(COPY_RETRY_DELAY)
                continue

            # Try to copy
            shutil.copy2(src, dst)
            return True

        except (PermissionError, OSError, IOError):
            # File might be locked by another process
            if attempt < retries - 1:
                time.sleep(COPY_RETRY_DELAY * (attempt + 1))  # Exponential backoff

    return False


# --- Event Handler ---
class MDHandler(FileSystemEventHandler):
    """Handles file system events for .md files with debouncing."""

    def __init__(
        self,
        root: Path,
        out_path: Path,
        mirror_to: Optional[Path] = None,
        prune: bool = False,
        index_root: Optional[Path] = None,
        max_depth: Optional[int] = None,
        dashboard: Optional[Dashboard] = None,
    ):
        super().__init__()
        self.root = root
        self.out_path = out_path
        self.mirror_to = mirror_to
        self.prune = prune
        self.max_depth = max_depth
        self.index_root = index_root if index_root is not None else root
        self.dashboard = dashboard

        self._pending_events: dict[str, tuple[str, Optional[str]]] = {}
        self._debounce_timer: Optional[threading.Timer] = None
        self._lock = threading.Lock()

    def _get_rel_path(self, path: Path) -> Optional[Path]:
        try:
            return path.relative_to(self.root)
        except ValueError:
            return None

    def _should_handle(self, path: Path) -> bool:
        if not is_md_file(path):
            return False
        # Exclude files in the mirror directory to prevent recursive processing
        if self.mirror_to:
            try:
                path.resolve().relative_to(self.mirror_to.resolve())
                return False  # Path is inside mirror directory
            except ValueError:
                pass  # Path is not inside mirror directory
        rel = self._get_rel_path(path)
        return rel is not None and should_include_path(rel)

    def _schedule_processing(self):
        with self._lock:
            if self._debounce_timer:
                self._debounce_timer.cancel()
            self._debounce_timer = threading.Timer(
                DEBOUNCE_SECONDS, self._process_pending
            )
            self._debounce_timer.start()

    def _queue_event(
        self, event_type: str, src_path: Path, dest_path: Optional[Path] = None
    ):
        key = str(src_path)
        with self._lock:
            existing = self._pending_events.get(key)
            if existing and existing[0] == "deleted" and event_type == "created":
                event_type = "modified"
            self._pending_events[key] = (
                event_type,
                str(dest_path) if dest_path else None,
            )
        self._schedule_processing()

    def _process_pending(self):
        with self._lock:
            events = dict(self._pending_events)
            self._pending_events.clear()
            self._debounce_timer = None

        if not events:
            return

        if self.dashboard:
            self.dashboard.set_status("Processing events...", STYLE_MODIFIED)

        # Process mirror operations
        if self.mirror_to:
            for src_str, (event_type, dest_str) in events.items():
                src = Path(src_str)
                rel = self._get_rel_path(src)
                rel_str = str(rel) if rel else src_str

                try:
                    success = True
                    if event_type == "deleted":
                        self._mirror_delete(src)
                    elif event_type == "moved" and dest_str:
                        self._mirror_move(src, Path(dest_str))
                    else:
                        success = self._mirror_copy(src)

                    if self.dashboard:
                        if success:
                            self.dashboard.log_activity(event_type, rel_str)
                        # Don't log failed copies as errors - file was likely locked
                        # It will be synced on the next modification event

                except Exception as e:
                    if self.dashboard:
                        self.dashboard.log_activity("error", rel_str, str(e))

        # Rebuild index
        # Only exclude mirror_to if indexing a directory that contains it (not the mirror itself)
        try:
            exclude = self.mirror_to if (self.mirror_to and self.index_root != self.mirror_to) else None
            write_index(
                self.index_root,
                self.out_path,
                self.max_depth,
                self.dashboard,
                exclude_dir=exclude,
            )
        except Exception as e:
            if self.dashboard:
                self.dashboard.log_activity("error", "index", str(e))

        if self.dashboard:
            self.dashboard.set_status("Watching for changes...", STYLE_SUCCESS)

    def _mirror_copy(self, src: Path) -> bool:
        """Copy file to mirror. Returns True on success."""
        if not self.mirror_to:
            return False
        rel = self._get_rel_path(src)
        if rel is None:
            return False
        dst = self.mirror_to / rel
        if copy_file_with_retry(src, dst):
            if self.dashboard:
                self.dashboard.increment_synced()
            return True
        return False

    def _mirror_delete(self, src: Path):
        if not self.mirror_to:
            return
        rel = self._get_rel_path(src)
        if rel is None:
            return
        dst = self.mirror_to / rel
        if dst.exists():
            dst.unlink()

    def _mirror_move(self, src: Path, dest: Path):
        if not self.mirror_to:
            return
        self._mirror_delete(src)
        if dest.exists():
            self._mirror_copy(dest)

    def _to_path(self, path: str | bytes) -> Path:
        if isinstance(path, bytes):
            return Path(path.decode("utf-8", errors="replace"))
        return Path(path)

    def on_created(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        src = self._to_path(event.src_path)
        if self._should_handle(src):
            self._queue_event("created", src)

    def on_modified(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        src = self._to_path(event.src_path)
        if self._should_handle(src):
            self._queue_event("modified", src)

    def on_deleted(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        src = self._to_path(event.src_path)
        if is_md_file(src):
            rel = self._get_rel_path(src)
            if rel is not None:
                self._queue_event("deleted", src)

    def on_moved(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        src = self._to_path(event.src_path)
        dest_path = getattr(event, "dest_path", None)
        if dest_path is None:
            return
        dest = self._to_path(dest_path)

        src_is_md = is_md_file(src)
        dest_is_md = is_md_file(dest)

        if src_is_md and not dest_is_md:
            rel = self._get_rel_path(src)
            if rel is not None:
                self._queue_event("deleted", src)
        elif not src_is_md and dest_is_md:
            if self._should_handle(dest):
                self._queue_event("created", dest)
        elif src_is_md and dest_is_md:
            self._queue_event("moved", src, dest)


# --- Sync functions ---
def initial_sync(
    root: Path,
    mirror_to: Path,
    max_depth: Optional[int] = None,
    dashboard: Optional[Dashboard] = None,
) -> int:
    """Perform initial sync of all .md files. Returns count."""
    mirror_to.mkdir(parents=True, exist_ok=True)
    copied = 0
    skipped = 0
    # Exclude the mirror directory to prevent recursive mirroring
    for rel_path, full_path in walk_md_files(root, max_depth, exclude_dir=mirror_to):
        dst = mirror_to / rel_path
        if copy_file_with_retry(full_path, dst):
            copied += 1
            if dashboard:
                dashboard.log_activity("sync", str(rel_path))
        else:
            skipped += 1  # File was locked or being written - will sync on next change
    if dashboard:
        dashboard.increment_synced(copied)
        if skipped > 0:
            dashboard.log_activity("skip", f"{skipped} files in use")
    return copied


def prune_mirror(
    root: Path,
    mirror_to: Path,
    max_depth: Optional[int] = None,
    dashboard: Optional[Dashboard] = None,
) -> int:
    """Remove files from mirror that no longer exist in source. Returns count."""
    # Exclude the mirror directory to prevent recursive scanning
    existing = {
        str(rel.as_posix())
        for rel, _ in walk_md_files(root, max_depth, exclude_dir=mirror_to)
    }

    removed = 0
    for mirror_file in mirror_to.rglob("*.md"):
        try:
            rel = mirror_file.relative_to(mirror_to)
        except ValueError:
            continue
        if str(rel.as_posix()) not in existing:
            try:
                mirror_file.unlink()
                removed += 1
                if dashboard:
                    dashboard.log_activity("prune", str(rel))
                    dashboard.increment_pruned()
            except OSError:
                continue  # Skip files that can't be removed
    return removed


def resolve_output_path(out_arg: str) -> Path:
    """Resolve the output path."""
    out_candidate = Path(out_arg)
    if out_candidate.is_absolute():
        return out_candidate.resolve()
    return (Path.cwd() / out_candidate).resolve()


# --- Main ---
def main():
    parser = argparse.ArgumentParser(
        description="Watch directory and sync .md files with a live dashboard."
    )
    parser.add_argument(
        "watch_dir",
        nargs="?",
        default=".",
        help="Directory to watch (default: current dir)",
    )
    parser.add_argument(
        "--out",
        "-o",
        default="files.json",
        help="Output JSON filename (default: files.json)",
    )
    parser.add_argument(
        "--mirror-to",
        default="md",
        help="Local directory to mirror .md files into (default: ./md)",
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help="Remove stale files from mirror destination",
    )
    parser.add_argument(
        "--max-depth",
        type=int,
        default=None,
        help="Limit recursion depth",
    )
    parser.add_argument(
        "--no-tui",
        action="store_true",
        help="Disable TUI, use simple logging instead",
    )
    parser.add_argument(
        "--port",
        "-p",
        type=int,
        default=DEFAULT_PORT,
        help=f"HTTP server port (default: {DEFAULT_PORT})",
    )
    parser.add_argument(
        "--no-server",
        action="store_true",
        help="Disable embedded HTTP server",
    )
    args = parser.parse_args()

    root = Path(args.watch_dir).resolve()
    mirror_to = Path(args.mirror_to).resolve() if args.mirror_to else None

    if not root.exists() or not root.is_dir():
        Console().print(f"[red]Error:[/red] Watched directory does not exist: {root}")
        sys.exit(2)

    # Index is always built from mirror directory (where web server can access files)
    index_root = mirror_to if mirror_to else root
    out_path = resolve_output_path(args.out)

    # Start embedded HTTP server
    web_server: Optional[WebServer] = None
    server_url: Optional[str] = None
    if not args.no_server:
        web_server = WebServer(Path.cwd(), args.port)
        if web_server.start():
            server_url = web_server.url
        else:
            Console().print(
                f"[yellow]Warning:[/yellow] Could not start server on port {args.port}"
            )
            web_server = None

    # Create dashboard
    dashboard: Optional[Dashboard] = None
    if not args.no_tui:
        dashboard = Dashboard(root, mirror_to, out_path, server_url)

    def run_watcher():
        if dashboard:
            dashboard.set_status("Initial sync...", STYLE_MODIFIED)

        # Initial sync
        if mirror_to:
            initial_sync(root, mirror_to, args.max_depth, dashboard)
            if args.prune:
                prune_mirror(root, mirror_to, args.max_depth, dashboard)

        # Write initial index
        # Only exclude mirror_to if we're indexing a directory that contains it (not the mirror itself)
        exclude = mirror_to if (mirror_to and index_root != mirror_to) else None
        write_index(index_root, out_path, args.max_depth, dashboard, exclude_dir=exclude)

        if dashboard:
            dashboard.set_status("Watching for changes...", STYLE_SUCCESS)

        # Start observer
        handler = MDHandler(
            root,
            out_path,
            mirror_to=mirror_to,
            prune=args.prune,
            index_root=index_root,
            max_depth=args.max_depth,
            dashboard=dashboard,
        )
        observer = Observer()
        observer.schedule(handler, str(root), recursive=True)
        observer.start()
        return observer

    if args.no_tui:
        # Simple mode without TUI
        print(f"Watching: {root}")
        print(f"Mirror:   {mirror_to}")
        print(f"Output:   {out_path}")
        if server_url:
            print(f"Server:   {server_url}")
        obs = run_watcher()
        try:
            while True:
                obs.join(1)
        except KeyboardInterrupt:
            print("\nStopping...")
            obs.stop()
        obs.join()
        if web_server:
            web_server.stop()
    else:
        # TUI mode - dashboard is guaranteed to exist here
        if dashboard is None:
            raise RuntimeError("Dashboard not initialized")
        console = Console()

        # Start watcher in background thread so TUI shows immediately
        started_observer: list = []  # Holds Observer instance once started
        watcher_error_msg: list[str] = []

        def start_watcher_thread() -> None:
            try:
                started_observer.append(run_watcher())
            except Exception as e:
                watcher_error_msg.append(str(e))

        watcher_thread = threading.Thread(target=start_watcher_thread, daemon=True)
        watcher_thread.start()

        try:
            with Live(
                dashboard.render(), console=console, refresh_per_second=4, screen=True
            ) as live:
                while True:
                    if watcher_error_msg:
                        dashboard.set_status(
                            f"Error: {watcher_error_msg[0]}", STYLE_ERROR
                        )
                    live.update(dashboard.render())
                    time.sleep(0.25)
        except KeyboardInterrupt:
            pass
        finally:
            if started_observer:
                started_observer[0].stop()
                started_observer[0].join()
            if web_server:
                web_server.stop()


if __name__ == "__main__":
    main()
