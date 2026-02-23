# Concert Splitter

A local web tool for splitting full concert recordings into individually tagged MP3 tracks.

## Features

- **Upload an MP3** or **paste a YouTube URL** to load a concert recording
- **Interactive waveform** (wavesurfer.js) with zoom for precise split placement
- **Preview** any segment before exporting
- **Mark dead space** to exclude intros, applause, or gaps from the export
- **Name each track** and set artist/album metadata
- **Export** all tracks as a zip of tagged MP3s (ID3: title, artist, album, track number)

## Requirements

- Python 3.10+
- [ffmpeg](https://ffmpeg.org/) (required by pydub for MP3 encoding)

## Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## Usage

```bash
source venv/bin/activate
python app.py
```

Open [http://localhost:5001](http://localhost:5001) in your browser.

1. Upload an MP3 or paste a YouTube link
2. Add split markers on the waveform at song boundaries
3. Name each track and fill in artist/album
4. Optionally mark segments as dead space to skip them
5. Click **Export All Tracks** to download a zip of tagged MP3s
