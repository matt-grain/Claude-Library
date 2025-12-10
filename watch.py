#!/usr/bin/env python3
"""
generate_index.py

Watches a directory recursively for added/modified/deleted .md files and regenerates
files.json (a JSON array of relative paths). Optionally mirrors changed files into a
local `md/` folder (or any directory) preserving relative paths.

Usage:
    pip install watchdog
    python watch.py [watch_dir] [--out files.json] [--mirror-to ../myproject/md] [--prune]

Defaults:
    watch_dir: current working directory
    out: files.json (created inside watch_dir unless a different path is passed)
    mirror-to: ./md (relative to current working directory)
    prune: false (when enabled, files in the mirror destination that are not
                 present in the watched tree will be removed)
"""

import sys
import json
from typing import Optional
import argparse
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileSystemEvent
import shutil


def build_index(root: Path, max_depth: Optional[int] = None):
    """Build index of .md files using os.walk for better WSL mount performance."""
    md_paths = []
    import os

    for dirpath, dirnames, filenames in os.walk(root):
        # compute depth relative to root
        rel_dir = Path(dirpath).relative_to(root)
        depth = len(rel_dir.parts)
        if max_depth is not None and depth > max_depth:
            dirnames.clear()  # don't recurse deeper
            continue
        # skip hidden directories except claude
        dirnames[:] = [d for d in dirnames if d.startswith(".claude") or not d.startswith(".")]
        for fname in sorted(filenames):
            print(f"{dirpath} / {fname}")
            if fname.lower().endswith(".md"):
                full_path = Path(dirpath) / fname
                try:
                    rel = full_path.relative_to(root)
                    if not any(part.startswith(".") for part in rel.parts) or rel.parts[0] == ".claude":
                        md_paths.append(str(rel.as_posix()))

                except Exception:
                    pass
    return sorted(md_paths)


def write_index(root: Path, out_path: Path, max_depth: Optional[int] = None):
    md = build_index(root, max_depth=max_depth)
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    tmp.write_text(json.dumps(md, indent=2, ensure_ascii=False))
    tmp.replace(out_path)
    print(f"[index] Wrote {len(md)} entries to {out_path}")


class MDHandler(FileSystemEventHandler):
    def __init__(
        self,
        root: Path,
        out_path: Path,
        mirror_to: Optional[Path] = None,
        prune: bool = False,
        index_root: Optional[Path] = None,
        max_depth: Optional[int] = None,
    ):
        super().__init__()
        self.root = root
        self.out_path = out_path
        self.mirror_to = mirror_to
        self.prune = prune
        self.max_depth = max_depth
        # index_root is the directory to use when generating files.json
        self.index_root = index_root if index_root is not None else root

    def _is_md(self, path: str):
        return path.lower().endswith(".md")

    def on_any_event(self, event: FileSystemEvent):
        # Only act on file events that affect .md files
        # event.src_path may be a string path
        try:
            src = Path(str(event.src_path))
        except Exception:
            return
        # ignore directories
        if src.is_dir():
            return
        if not self._is_md(str(src)):
            return
        # For moved events, also check dest_path
        if hasattr(event, "dest_path") and event.dest_path:
            dest = Path(str(event.dest_path))
            if not self._is_md(str(dest)):
                return
        # Rebuild index on any relevant change using configured index_root
        try:
            write_index(self.index_root, self.out_path, max_depth=self.max_depth)
        except Exception as e:
            print("[error] Failed to write index:", e)

        # Mirror the changed file(s) into local mirror directory if requested
        if self.mirror_to:
            try:
                # moved events include dest_path
                if getattr(event, "event_type", "") == "moved" and getattr(
                    event, "dest_path", None
                ):
                    src = Path(str(event.src_path))
                    destp = Path(str(event.dest_path))
                    self._mirror_move(src, destp)
                elif getattr(event, "event_type", "") == "deleted":
                    src = Path(str(event.src_path))
                    self._mirror_delete(src)
                else:
                    src = Path(str(event.src_path))
                    self._mirror_copy(src)
            except Exception as me:
                print("[mirror] Error handling mirror operation:", me)

    def _rel_to_root(self, path: Path):
        try:
            return path.relative_to(self.root)
        except Exception:
            return None

    def _mirror_copy(self, src: Path):
        if not self.mirror_to:
            return
        if not src.exists() or not src.is_file():
            return
        rel = self._rel_to_root(src)
        if rel is None:
            return
        dst = self.mirror_to / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(src, dst)
            print(f"[mirror] Copied {src} -> {dst}")
        except Exception as e:
            print("[mirror] Copy failed:", e)

    def _mirror_delete(self, src: Path):
        if not self.mirror_to:
            return
        rel = self._rel_to_root(src)
        if rel is None:
            return
        dst = self.mirror_to / rel
        if dst.exists():
            try:
                dst.unlink()
                print(f"[mirror] Removed {dst}")
            except Exception as e:
                print("[mirror] Remove failed:", e)

    def _mirror_move(self, src: Path, destp: Path):
        if not self.mirror_to:
            return
        # remove old copy (if any) and copy new
        self._mirror_delete(src)
        # copy dest file if exists
        if Path(destp).exists():
            self._mirror_copy(Path(destp))


def main():
    parser = argparse.ArgumentParser(
        description="Watch directory and regenerate files.json for .md files."
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
        help="Output JSON filename (relative to watch_dir)",
    )
    parser.add_argument(
        "--mirror-to",
        default="md",
        help="Local directory to mirror changed .md files into (default: ./md)",
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help="If set, remove files from mirror destination that are not present in the watched tree",
    )
    parser.add_argument(
        "--index-source",
        choices=("watch", "mirror"),
        default=None,
        help="Where to generate the files.json index from: 'watch' (watched tree) or 'mirror' (mirror destination). If omitted and --mirror-to is used, defaults to 'mirror'.",
    )
    parser.add_argument(
        "--max-depth",
        type=int,
        default=None,
        help="Limit recursion depth when scanning for .md files (useful for slow mounts like WSL Windows drives). Default: unlimited.",
    )
    args = parser.parse_args()

    root = Path(args.watch_dir).resolve()
    mirror_to = Path(args.mirror_to).resolve() if args.mirror_to else None

    # Validate watched directory exists before starting observer
    if not root.exists() or not root.is_dir():
        print(f"[error] Watched directory does not exist: {root}")
        sys.exit(2)

    print(f"Watching {root}")

    # Decide where to write the output file. If the index will be generated from
    # the mirror (local) directory, it's more useful to write `--out` relative
    # to the current working directory (where the mirror lives), otherwise write
    # it inside the watched root (legacy behavior).
    # Note: we compute `index_root` later; for now compute a tentative out_path
    # but adjust it after index_root is known.
    out_path = None

    # Decide which directory to use when writing the index: watched root or mirror
    index_source = args.index_source
    if index_source is None and mirror_to:
        index_source = "mirror"
    index_root = mirror_to if (mirror_to and index_source == "mirror") else root

    # Initial mirror: copy all .md files from watched tree into mirror destination
    if mirror_to:
        import os

        mirror_to.mkdir(parents=True, exist_ok=True)
        print(f"[mirror] Initial sync from {root} -> {mirror_to}")
        copied = 0
        for dirpath, dirnames, filenames in os.walk(root):
            rel_dir = Path(dirpath).relative_to(root)
            depth = len(rel_dir.parts)
            if args.max_depth is not None and depth > args.max_depth:
                dirnames.clear()
                continue

            dirnames[:] = [d for d in dirnames if (d.startswith(".claude") or not d.startswith(".")) and d not in ['__pycache__']]

            for fname in sorted(filenames):
                if not fname.lower().endswith(".md"):
                    continue

                # print(f"Syncing {dirpath} {dirnames} {fname}")

                src = Path(dirpath) / fname
                try:
                    rel = src.relative_to(root)
                    if any(part.startswith(".") for part in rel.parts) and rel.parts[0] != ".claude":
                        print(f"Skipping {rel} {rel.parts[0] }")
                        continue

                    dst = mirror_to / rel
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dst)
                    copied += 1
                except Exception as e:
                    print("[mirror] initial copy failed for", src, e)

        print(f"[mirror] Completed initial copy: {copied} files")
        if args.prune:
            # remove any md files under mirror_to that don't exist in watched root
            existing = set(
                str(p.relative_to(root).as_posix())
                for p in root.rglob("*")
                if p.is_file() and p.suffix.lower() == ".md"
            )
            removed = 0
            for q in mirror_to.rglob("*.md"):
                try:
                    relq = q.relative_to(mirror_to)
                except Exception:
                    continue
                # compare POSIX-style relative path
                if str(relq.as_posix()) not in existing:
                    try:
                        q.unlink()
                        removed += 1
                    except Exception as e:
                        print("[mirror] prune remove failed for", q, e)
            print(f"[mirror] Prune removed: {removed} files")
    # Decide output path: write `--out` into the current working directory by default
    # unless an absolute path was provided. This keeps `files.json` in this repo.
    out_candidate = Path(args.out)
    if out_candidate.is_absolute():
        out_path = out_candidate
    else:
        out_path = Path.cwd() / out_candidate
    out_path = out_path.resolve()

    # After initial mirror (if any), write the index from the chosen source
    try:
        write_index(index_root, out_path, max_depth=args.max_depth)
    except Exception as e:
        print("[error] Initial write failed:", e)
        raise

    event_handler = MDHandler(
        root,
        out_path,
        mirror_to=mirror_to,
        prune=args.prune,
        index_root=index_root,
        max_depth=args.max_depth,
    )
    observer = Observer()
    observer.schedule(event_handler, str(root), recursive=True)
    observer.start()
    print(f"[watch] Watching {root} (output: {out_path}) — press Ctrl+C to stop")
    try:
        while True:
            observer.join(1)
    except KeyboardInterrupt:
        print("\n[watch] Stopping…")
        observer.stop()
    observer.join()


if __name__ == "__main__":
    main()
