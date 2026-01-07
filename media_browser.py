from dataclasses import dataclass
from typing import Dict, List, Set, Optional, NewType

import argparse
import hashlib
import json
import logging
import mimetypes
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps

# ---------------- Globals ----------------

BASE_DIR: Path = Path(__file__).resolve().parent
logger = logging.getLogger("uvicorn.error")

IMAGE_EXTS: Set[str] = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".ico"
}
VIDEO_EXTS: Set[str] = {
    # Common web/desktop video formats
    ".mp4", ".m4v", ".mov", ".webm", ".ogv", ".ogg", ".mkv",
    ".flv",
    ".avi", ".wmv",
    ".mpeg", ".mpg", ".ts", ".m2ts", ".m2v",
    ".vob",
    # Mobile /legacy
    ".3gp",
    # Flash / streaming formats
    ".swf", ".asf", ".ra", ".ram", ".rm"
}
THUMB_SIZE = (320, 320)

SEARCH_FONT_DIRS = [
    Path.home() / ".local/share/fonts",
    Path("/usr/share/fonts"),
    Path("/usr/local/share/fonts"),
]

# ---------------- CLI ----------------

@dataclass(slots=True)
class AppState:
    cache_dir: Path
    hls_dir: Path
    root_dirs: List[Path]
    virtual_map: Dict[str, Path]
    font_file: object = None

def parse_args():
    parser = argparse.ArgumentParser(
        description="Simple local media browser (images & videos)"
    )
    parser.add_argument(
        "--bind", default="0.0.0.0",
        help="IP address to bind to (default: 0.0.0.0)"
    )
    parser.add_argument(
        "--port", type=int, default=7000,
        help="Port to listen on (default: 7000)"
    )
    parser.add_argument(
        "--cache-dir",
        default=None,
        help="Directory to store cached thumbnails and videos (default: XDG cache)"
    )
    parser.add_argument(
        "directories",
        nargs="+",  # one or more
        help="Directories to serve as roots"
    )
    args = parser.parse_args()

    if args.cache_dir is None:
        cache_dir = get_default_cache_dir() / "media_browser_cache"
        print(f"Using default directory: {cache_dir}")
    else:
        cache_dir = Path(os.path.abspath(args.cache_dir))

    hls_dir = cache_dir / "hls"

    root_dirs = [Path(d).resolve() for d in args.directories]
    for d in root_dirs:
        if not d.is_dir():
            sys.exit(f"Not a directory: {d}")

    appstate = AppState(
        cache_dir=cache_dir,
        hls_dir=hls_dir,
        root_dirs=root_dirs,
        virtual_map={}
    )

    return args, appstate

def get_default_cache_dir() -> Path:
    if sys.platform.startswith("win"):
        return Path(os.getenv("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        return Path.home() / "Library" / "Caches"
    else:  # Linux / Unix
        return Path(os.getenv("XDG_CACHE_HOME", Path.home() / ".cache"))

# ---------------- Path encoding ----------------

OSPATH_PREFIX = "~~OSPATH~~"

OsPath = NewType("OsPath", str)

def encode_ospath(s: str) -> OsPath:
    try:
        s.encode("utf-8")
        return OsPath(s)
    except UnicodeEncodeError:
        pass

    b = s.encode("utf-8", errors="surrogateescape")
    encoded = "".join(
        "~7E" if byte == 0x7E else
        chr(byte) if byte < 0x80 else
        f"~{byte:02X}"
        for byte in b
    )
    return OsPath(OSPATH_PREFIX + encoded)

def decode_ospath(ospath: OsPath) -> str:
    s = str(ospath)
    if not s.startswith(OSPATH_PREFIX):
        return s

    s = s[len(OSPATH_PREFIX):]
    out = bytearray()
    i = 0
    length = len(s)

    while i < length:
        c = s[i]
        if c == "~":
            if i + 2 >= length:
                raise ValueError(f"Incomplete escape sequence at position {i}: {s[i:]}")
            hex_part = s[i + 1:i + 3]
            try:
                out.append(int(hex_part, 16))
            except ValueError:
                raise ValueError(f"Invalid hex in escape sequence at position {i}: {hex_part}")
            i += 3
        else:
            # encode a consecutive run of non-tilde characters in one go
            start = i
            while i < length and s[i] != "~":
                i += 1
            out.extend(s[start:i].encode("utf-8", errors="surrogateescape"))

    return out.decode("utf-8", errors="surrogateescape")

# ---------------- Virtual path mapping ----------------

@dataclass(slots=True)
class TreeNode:
    name: OsPath
    dirs: List["TreeNode"]

def build_virtual_map(state: AppState):
    for root in state.root_dirs:
        key = encode_ospath(root.name)
        if key in state.virtual_map:
            sys.exit(f"Duplicate directory names not allowed: {root.name}")
        state.virtual_map[key] = root

def build_trees(appstate: AppState) -> List[TreeNode]:
    def walk(p: Path):
        node = TreeNode(
            name=encode_ospath(p.name),
            dirs=[]
            )
        for d in sorted(p.iterdir()):
            if d.is_dir() and not d.name.startswith("."):
                node.dirs.append(walk(d))
        return node

    trees = [
        walk(path)
        for name, path in appstate.virtual_map.items()
    ]
    return trees

def safe_path(appstate: AppState, virtual_path: OsPath) -> Path:
    """
    Resolve virtual path (<root>/<subdir>/...) to real filesystem path,
    with basic safety checks.
    """
    try:
        vp = decode_ospath(virtual_path)

        # First segment must be a known root
        root, *rest = vp.split("/", 1)
        base = appstate.virtual_map[root]

        # Resolve the remainder (if any)
        if not rest:
            candidate = base
        else:
            candidate = (base / rest[0]).resolve()

        # Ensure the resolved path stays within the root
        candidate.relative_to(base)

        return candidate

    except Exception:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail=f"Invalid path: {virtual_path}")

# ---------------- Thumbnails ----------------

def is_image(p: Path):
    return p.suffix.lower() in IMAGE_EXTS

def is_video(p: Path):
    return p.suffix.lower() in VIDEO_EXTS

def hash_path(path: Path) -> str:
    # This also handles non-utf-8 paths.
    return hashlib.sha256(bytes(path)).hexdigest()

def thumb_path(appstate: AppState, src: Path) -> Path:
    h = hash_path(src)
    return appstate.cache_dir / f"{h[:2]}/{h[2:]}.jpg"

def find_font(font_name: str) -> Optional[Path]:
    for base_dir in SEARCH_FONT_DIRS:
        if not base_dir.is_dir():
            continue
        for path in base_dir.rglob(font_name):
            if path.is_file():
                return path
    return None

def gen_image_thumb(src: Path, dst: Path) -> bool:
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail(THUMB_SIZE)
            im.convert("RGB").save(dst, "JPEG", quality=85)
        return True
    except Exception as e:
        logger.warning(f"Failed to generate thumbnail for {src}: {e}")
        return False

def gen_video_thumb(appstate: AppState, src: Path, dst: Path) -> bool:
    """Generate a video thumbnail with duration overlay."""
    # First, get the video duration
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error",
             "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1",
             str(src)],
            capture_output=True, text=True, check=True
        )
        sec = float(result.stdout.strip())
        h,m,s = int(sec//3600), int((sec%3600)//60), int(sec%60)
        if h > 0:
            duration = f"{h}\\:{m:02d}\\:{s:02d}"
        else:
            duration = f"{m:02d}\\:{s:02d}"
    except Exception:
        duration = ""

    # Search for font file only once.
    if duration and appstate.font_file is None:
        appstate.font_file = find_font("DejaVuSans.ttf") or ""
    font_file = appstate.font_file

    filters = [f"thumbnail,scale={THUMB_SIZE[0]}:-1"]
    if duration:
        dt = f"drawtext=text='{duration}':x=w-tw-8:y=8"
        dt += ":box=1:boxborderw=8:boxcolor=0x000000aa"
        dt += ":fontsize=24:fontcolor=0xcccccc"
        if font_file:
            dt += f":fontfile='{font_file}'"
        filters.append(dt)
    vf = ",".join(filters)

    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error",
             "-i", str(src),
             "-frames:v", "1",
             "-vf", vf,
             str(dst)],
            check=False
        )
        return dst.exists()
    except Exception:
        logger.warning(f"Failed to generate thumbnail for {src}")
        return False

@dataclass(frozen=True)
class ThumbResult:
    path: Path
    ok: bool
    src_found: bool

def ensure_thumb(appstate: AppState, src: Path) -> tuple[str, Path]:
    dst = thumb_path(appstate, src)

    if not src.is_file():
        return ("src_not_found", dst)

    if dst.exists():
        dst_stat = dst.stat()
        src_mtime = src.stat().st_mtime

        if dst_stat.st_mtime >= src_mtime:
            if dst_stat.st_size > 0:
                return ("ok", dst)
            else:
                return ("error", dst)

    # Generate new thumbnail.
    generated = False
    if is_image(src):
        generated = gen_image_thumb(src, dst)
    elif is_video(src):
        generated = gen_video_thumb(appstate, src, dst)
    if generated:
        return ("ok", dst)

    # Leave an empty thumbnail to indicate error.
    with open(dst, "wb") as f:
        f.write(b"")
    return ("error", dst)

# ---------------- Video formats ----------------

@dataclass(slots=True)
class StreamInfo:
    codec: str
    index: int              # ffmpeg stream index

@dataclass(slots=True)
class VideoInfo:
    ext: str
    video: List[StreamInfo]
    audio: List[StreamInfo]

def get_video_info(src: Path) -> Optional[VideoInfo]:
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "stream=index,codec_type,codec_name",
        "-of", "json",
        str(src),
    ]
    try:
        out = subprocess.check_output(cmd)
        data = json.loads(out)
    except Exception:
        return None

    ext = src.suffix.lstrip(".").lower()
    video = []
    audio = []

    for s in data.get("streams", []):
        ctype = s.get("codec_type")
        cname = s.get("codec_name")
        idx = s.get("index")

        if not cname or idx is None:
            continue

        cname = cname.lower()

        if ctype == "video":
            video.append(StreamInfo(codec=cname, index=idx))
        elif ctype == "audio":
            audio.append(StreamInfo(codec=cname, index=idx))

    if video or audio:
        return VideoInfo(ext=ext, video=video, audio=audio)

    return None

# suitable for HLS
HLS_VIDEO_COPY_CODECS = {"h264", "avc1"}
HLS_AUDIO_COPY_CODECS = {"aac", "mp3"}

def choose_stream(streams: list[StreamInfo],
                  preferred_codecs: set[str]) -> Optional[StreamInfo]:
    for s in streams:
        if s.codec in preferred_codecs:
            return s
    return streams[0] if streams else None

# ---------------- HLS ----------------

@dataclass(slots=True)
class HLSJob:
    proc: subprocess.Popen  # ffmpeg
    out_dir: Path
    last_access: float
    waited: bool = False

hls_jobs: dict[str, HLSJob] = {}
hls_jobs_lock = threading.Lock()
HLS_IDLE_TIMEOUT = 30   # seconds

def start_hls_ffmpeg_process(src: Path,
                             outdir: Path,
                             info: VideoInfo) -> subprocess.Popen:
    """Start producing a HLS stream to outdir."""
    outdir.mkdir(parents=True, exist_ok=True)

    video = choose_stream(info.video, HLS_VIDEO_COPY_CODECS)
    audio = choose_stream(info.audio, HLS_AUDIO_COPY_CODECS)

    cmd = [
        "ffmpeg", "-loglevel", "error", "-y",
        "-i", str(src),
    ]

    if video:
        cmd += ["-map", f"0:{video.index}"]
    if audio:
        cmd += ["-map", f"0:{audio.index}"]

    msg = "ffmpeg: "

    if video and video.codec in HLS_VIDEO_COPY_CODECS:
        msg += f"copy video ({video.codec})"
        cmd += ["-c:v", "copy"]
    elif video:
        msg += f"re-encode video ({video.codec})"
        cmd += [
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                                        # force even dimensions for libx264
            "-c:v", "libx264",          # H.264 video
            "-preset", "veryfast",      # veryfast encoding
            "-g", "48",                 # GOP size (keyframe interval) in frames
            "-keyint_min", "48",        # minimum keyframe interval
            "-sc_threshold", "0",       # disable scene cut detection
            #"-profile:v", "baseline",  # optional: device compatibility
        ]
    else:
        msg += "no video stream"

    if audio and audio.codec in HLS_AUDIO_COPY_CODECS:
        msg += f", copy audio ({audio.codec})"
        cmd += ["-c:a", "copy"]
    elif audio:
        msg += f", re-encode audio ({audio.codec})"
        cmd += [
            "-c:a", "aac",
            "-b:a", "128k"
        ]
    else:
        msg += ", no audio"

    logger.info(msg)

    cmd += [
        "-f", "hls",                # HLS format
        "-hls_time", "5",           # segment duration in seconds
        "-hls_list_size", "0",      # keep all segments in playlist
        "-hls_segment_filename", str(outdir / "seg%03d.ts"),
        str(outdir / "index.m3u8"), # playlist output
    ]

    return subprocess.Popen(cmd)

def start_or_reuse_hls_job(src: Path,
                           key: str,
                           out_dir: Path,
                           info: VideoInfo) -> tuple[HLSJob, bool]:
    """
    Ensure an HLS job exists or is running.
    """
    playlist_path = out_dir / "index.m3u8"
    incomplete_marker = out_dir / "incomplete"
    complete_marker = out_dir / "complete"
    error_marker = out_dir / "error"

    with hls_jobs_lock:
        # Reuse existing running job
        job = hls_jobs.get(key)
        if job is not None:
            job.last_access = time.time()
            return (job, False)

        # No job yet - start ffmpeg
        try:
            out_dir.mkdir(parents=True)
        except FileExistsError:
            # Delete an old playlist to prevent clients buffering up existing
            # segments, and not needing to make requests for a long time.
            # If that happens, we may kill the ffmpeg process by the time the
            # client wants to get the next segments.
            playlist_path.unlink(missing_ok=True)
        incomplete_marker.touch()
        proc = start_hls_ffmpeg_process(src, out_dir, info)

        job = HLSJob(
            proc=proc,
            out_dir=out_dir,
            last_access=time.time(),
        )
        hls_jobs[key] = job

    # on_finish runs in a thread.
    def on_finish():
        try:
            job.proc.wait()
        except Exception as e:
            logger.warning(f"Exception while waiting for ffmpeg: {e}")

        with hls_jobs_lock:
            # Just in case, don't bother to wait again if idle
            # and don't keep bumping the last_access time.
            # Let hls_reaper remove the job after idle.
            job.waited = True

        rc = job.proc.returncode
        if rc == 0:
            logger.info(f"Job {key} - marking as complete")
            incomplete_marker.rename(complete_marker)
        elif rc < 0:
            logger.info(f"Job {key} - ffmpeg killed by signal {-rc}")
        elif rc == 255:
            pass    # server killed, not ffmpeg error
        else:
            logger.info(f"Job {key} - marking as error, ffmpeg exit code {rc}")
            error_marker.touch()

    thread = threading.Thread(target=on_finish, daemon=True)
    thread.start()
    return (job, True)  # new job

def bump_hls_job_time(key: str):
    with hls_jobs_lock:
        job = hls_jobs.get(key)
        if job and not job.waited:
            # logger.info(f"Job {key} - last_access {job.last_access}")
            job.last_access = time.time()

def hls_reaper():
    """
    Kill ffmpeg for idle jobs and remove them from memory immediately.
    """
    while True:
        time.sleep(5)
        now = time.time()
        with hls_jobs_lock:
            for key, job in list(hls_jobs.items()):
                idle_time = now - job.last_access
                # logger.info(f"Job {key} - idle time: {idle_time}")
                if idle_time > HLS_IDLE_TIMEOUT:
                    try:
                        if job.waited:
                            logger.info(f"Job {key} - idle, already waited")
                        else:
                            logger.info(f"Job {key} - idle, killing ffmpeg process")
                            job.proc.kill()
                            job.proc.wait(timeout=5)
                            job.waited = True
                    except Exception:
                        pass

                    logger.info(f"Job {key} - removing job")
                    del hls_jobs[key]

def wait_for_file_ready(path: Path, timeout: float, interval: float) -> bool:
    """
    Wait until path exists and is non-empty.
    Returns True if ready, False on timeout.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if path.stat().st_size > 0:
                return True
        except FileNotFoundError:
            pass
        time.sleep(interval)
    return False

# ---------------- API ----------------

app = FastAPI()

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

@app.get("/")
def index():
    return FileResponse(BASE_DIR / "static/media_browser.html")

@app.get("/api/tree")
def tree(request: Request) -> dict:
    dirs = build_trees(request.app.state.appstate)
    return {"dirs": dirs}

@app.post("/api/list-batch")
def list_batch(request: Request, dirs: List[dict]) -> JSONResponse:
    """
    dirs: [
        {"path": "/some/dir", "since": 1690000000.0},
        {"path": "/other/dir"}
    ]
    """
    result = {}

    try:
        for entry in dirs:
            path = entry["path"]
            client_mtime = entry.get("since")

            base = safe_path(request.app.state.appstate, path)
            try:
                dir_mtime = base.stat().st_mtime
            except FileNotFoundError:
                result[path] = {"not_modified": False, "mtime": None, "files": []}
                continue

            # Check if client already has up-to-date info
            if client_mtime and dir_mtime <= float(client_mtime):
                result[path] = {"not_modified": True}
                continue

            # Enumerate files
            files = []
            for p in base.iterdir():
                if p.name.startswith("."):
                    continue
                if is_image(p) or is_video(p):
                    st = p.stat()
                    files.append({
                        "name": encode_ospath(p.name),
                        "type": "video" if is_video(p) else "image",
                        "mtime": st.st_mtime,
                        "size": st.st_size,
                    })

            result[path] = {"not_modified": False, "mtime": dir_mtime, "files": files}

    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST)

    return JSONResponse(result)

@app.get("/api/thumb")
def thumb(request: Request, path: OsPath) -> FileResponse:
    appstate = request.app.state.appstate
    src = safe_path(appstate, path)
    match ensure_thumb(appstate, src):
        case ("ok", dst):
            return FileResponse(dst, media_type="image/jpeg")
        case ("src_not_found", dst):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
        case _: # error
            raise HTTPException(status_code=status.HTTP_410_GONE,
                                detail="Missing thumbnail")

@app.get("/api/file")
def file(request: Request, path: OsPath) -> FileResponse:
    appstate = request.app.state.appstate
    src = safe_path(appstate, path)
    if src.is_file():
        mime, _ = mimetypes.guess_type(src)
        mime = mime or "application/octet-stream"
        return FileResponse(src, media_type=mime)
    else:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

@app.get("/api/start_hls")
def start_hls(request: Request, path: OsPath) -> dict:
    appstate = request.app.state.appstate
    src = safe_path(appstate, path)
    if not src.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    # Get video/audio info
    info = get_video_info(src)
    if not info:
        return {"error": "Not a video or audio file"}

    key = hash_path(src)
    out_dir = appstate.hls_dir / key
    complete_marker = out_dir / "complete"
    error_marker = out_dir / "error"
    playlist_path = out_dir / "index.m3u8"
    playlist_url = f"/hls/{key}/index.m3u8"

    # Check for previous transcode
    if complete_marker.exists():
        logger.info(f"Have complete marker for {key}")
        return {"playlist": playlist_url}
    if error_marker.exists():
        logger.info(f"Have error marker for {key}")
        return {"error": "Transcode unavailable"}

    # Start or reuse HLS job
    try:
        job, new_job = start_or_reuse_hls_job(src, key, out_dir, info)
        if new_job:
            logger.info(f"Job {key} - new ffmpeg process")
        else:
            logger.info(f"Job {key} - existing ffmpeg process")
    except Exception as e:
        logger.exception(f"Failed to start HLS job for {src}: {e}")
        return {"error": "Error starting HLS job"}

    # Wait a short time for the playlist to appear
    ready = wait_for_file_ready(playlist_path, timeout=10, interval=0.2)
    if not ready:
        return {"error": "Transcode failed or timed out"}

    return {"playlist": playlist_url}

@app.get("/hls/{key}/index.m3u8")
def hls_playlist(request: Request, key: str):
    appstate = request.app.state.appstate
    path = appstate.hls_dir / key / "index.m3u8"
    if path.is_file():
        bump_hls_job_time(key)
        return FileResponse(path, media_type="application/vnd.apple.mpegurl")
    else:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

@app.get("/hls/{key}/{segment}")
def hls_segment(request: Request, key: str, segment: str):
    appstate = request.app.state.appstate
    bump_hls_job_time(key)  # even if segment not ready yet
    path = appstate.hls_dir / key / segment
    if path.is_file():
        return FileResponse(path, media_type="video/MP2T")
    else:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

# ---------------- Main ----------------

def local_hostname() -> str:
    try:
        name = socket.getfqdn()
        if name and name != "localhost" and "." in name:
            return name
    except Exception:
        pass
    return "localhost"

def main():
    args, appstate = parse_args()

    build_virtual_map(appstate)

    (bind, port) = (args.bind, args.port)
    if bind in ("0.0.0.0", "::"):
        url = f"http://{local_hostname()}:{port}"
    else:
        url = f"http://{bind}:{port}"
    print()
    print(f"Open in browser: {url}")
    print()

    # Start reaper in background
    threading.Thread(target=hls_reaper, daemon=True).start()

    app.state.appstate = appstate
    uvicorn.run(app, host=bind, port=port)

if __name__ == "__main__":
    main()
