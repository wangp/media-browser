Media Browser
=============

A simple web application for browsing local image and video collections.
It runs a Python-based web server and presents a browser interface for
exploring directories, viewing images and playing videos.

I wrote it for me, but you might like it, too.


Features
--------

* Directory tree side panel.
* Sorting and filtering by media type, file name, modification time, or size.
* Thumbnail grid with optional recursive listing and grouping by directory.
* Thumbnail generation for images and videos.
* Native video playback when supported by the browser.
* HLS transcoding for unsupported formats using FFmpeg.


Dependencies
------------

* Python 3.10+
* Python modules:
  * [FastAPI](https://fastapi.tiangolo.com/)
  * [Uvicorn](https://www.uvicorn.dev/)
  * [Pillow](https://python-pillow.github.io) for image thumbnail generation
* [FFmpeg](https://ffmpeg.org/) for video thumbnailing and HLS transcoding
* `uv` for the `run.sh` script (optional)

The `run.sh` script uses `uv` to create the necessary Python environment.
You don't need to install Python or any of the Python modules separately
if using `uv`.


Starting the server
-------------------

```bash
./run.sh [options] <dir1> [dir2 ...]
```

Options:

* `--bind <IP>` - IP address to listen on (default: 0.0.0.0)
* `--port <PORT>` - port to listen on (default: 7000)
* `--cache-dir <DIR>` - directory to store thumbnails and transcoded videos
  (default: XDG cache)

Example:

```bash
./run.sh --cache-dir /var/tmp/media_browser_cache ~/Pictures ~/Videos
```

Open the printed URL in your web browser.

Also included is a sample `run-bwrap.sh` script to run the server in a
sandboxed environment using Bubblewrap. Adapt as required.


User interface
--------------

### Thumbnail grid

* Left click - view image or video
* Right click - context menu
* Shift + Right click - open native context menu

### Viewer shortcuts

* Escape - close viewer
* <, > - show previous or next item
* p, n - show previous or next item
* a - toggle auto-advance
* s - toggle shuffle mode (random order)
* f - toggle fullscreen

Viewing image:

* Left/Right - show previous or next item
* z - reset/toggle zoom mode
* mouse wheel - navigate items
* Ctrl + mouse wheel - zoom

Viewing video:

* Left/Right - seek 5 seconds
* Up/Down - seek 60 seconds
* Space - play or pause video
* m - mute or unmute video
* 9, 0 - adjust volume


Cache behaviour
---------------

The cache directory contains image/video thumbnails and transcoded video
outputs. It is not automatically cleared.


Security considerations
-----------------------

Obviously, only use this thing on a trusted local network.


Author
======

Peter Wang <novalazy@gmail.com>

