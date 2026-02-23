import io
import os
import re
import tempfile
import zipfile
from pathlib import Path

import yt_dlp
from flask import Flask, jsonify, render_template, request, send_file, send_from_directory
from mutagen.id3 import ID3, TALB, TIT2, TPE1, TRCK
from pydub import AudioSegment

app = Flask(__name__)

UPLOAD_DIR = Path(tempfile.mkdtemp(prefix="concert_splitter_"))


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify(error="No file provided"), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify(error="Empty filename"), 400

    filename = Path(file.filename).name
    dest = UPLOAD_DIR / filename
    file.save(dest)

    audio = AudioSegment.from_mp3(dest)
    duration = len(audio) / 1000.0

    return jsonify(filename=filename, duration=duration)


@app.route("/download", methods=["POST"])
def download_yt():
    data = request.get_json()
    url = (data or {}).get("url", "").strip()
    if not url:
        return jsonify(error="No URL provided"), 400

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(UPLOAD_DIR / "%(title)s.%(ext)s"),
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ],
        "quiet": True,
        "no_warnings": True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get("title", "download")
    except Exception as e:
        return jsonify(error=str(e)), 500

    safe_title = re.sub(r'[<>:"/\\|?*]', "_", title)
    mp3_path = UPLOAD_DIR / f"{safe_title}.mp3"

    if not mp3_path.exists():
        candidates = list(UPLOAD_DIR.glob("*.mp3"))
        if not candidates:
            return jsonify(error="Download succeeded but MP3 file not found"), 500
        mp3_path = max(candidates, key=lambda p: p.stat().st_mtime)

    audio = AudioSegment.from_mp3(mp3_path)
    duration = len(audio) / 1000.0
    filename = mp3_path.name

    return jsonify(filename=filename, duration=duration, title=title)


@app.route("/audio/<filename>")
def serve_audio(filename):
    return send_from_directory(UPLOAD_DIR, filename)


@app.route("/split", methods=["POST"])
def split():
    data = request.get_json()
    if not data:
        return jsonify(error="Invalid JSON"), 400

    filename = data.get("filename")
    artist = data.get("artist", "")
    album = data.get("album", "")
    tracks = data.get("tracks", [])

    if not filename or not tracks:
        return jsonify(error="Missing filename or tracks"), 400

    filepath = UPLOAD_DIR / filename
    if not filepath.exists():
        return jsonify(error="File not found"), 404

    audio = AudioSegment.from_mp3(filepath)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, track in enumerate(tracks):
            name = track.get("name", f"Track {i + 1}")
            start_ms = int(float(track["start"]) * 1000)
            end_ms = int(float(track["end"]) * 1000)

            segment = audio[start_ms:end_ms]

            safe_name = "".join(c for c in name if c.isalnum() or c in " -_().").strip()
            out_name = f"{i + 1:02d} - {safe_name}.mp3"

            tmp_path = UPLOAD_DIR / out_name
            segment.export(tmp_path, format="mp3")

            tags = ID3(tmp_path)
            tags.add(TIT2(encoding=3, text=name))
            if artist:
                tags.add(TPE1(encoding=3, text=artist))
            if album:
                tags.add(TALB(encoding=3, text=album))
            tags.add(TRCK(encoding=3, text=str(i + 1)))
            tags.save()

            zf.write(tmp_path, out_name)
            os.remove(tmp_path)

    buf.seek(0)
    zip_name = f"{album or 'tracks'}.zip"
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=zip_name)


if __name__ == "__main__":
    print(f"Uploads stored in: {UPLOAD_DIR}")
    app.run(debug=True, port=5001)
