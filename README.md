# Concert Splitter

A browser-based tool for splitting full concert recordings into individually tagged MP3 tracks. Runs entirely client-side -- no server required.

**[Try it live](https://nathanklassen7.github.io/Tiny-Desk-Extractor/)**

## Features

- **Load an MP3** via drag-and-drop or file picker
- **Interactive waveform** (wavesurfer.js) with zoom for precise split placement
- **Preview** any segment before exporting
- **Mark dead space** to exclude intros, applause, or gaps from the export
- **Name each track** and set artist/album metadata
- **Export** all tracks as a zip of tagged MP3s (ID3: title, artist, album, track number)

## How it works

Everything runs in your browser:

- **[ffmpeg.wasm](https://ffmpegwasm.netlify.app/)** splits the MP3 without re-encoding (`-c copy`)
- **[browser-id3-writer](https://github.com/browserkit/browser-id3-writer)** writes ID3v2 metadata tags
- **[JSZip](https://stuk.github.io/jszip/)** bundles the output files for download
- **[wavesurfer.js](https://wavesurfer-js.org/)** renders the waveform and handles region selection

## Usage

1. Open `index.html` locally or visit the [GitHub Pages site](https://nathanklassen7.github.io/Tiny-Desk-Extractor/)
2. Drop an MP3 of a full concert
3. Add split markers on the waveform at song boundaries
4. Name each track and fill in artist/album
5. Optionally mark segments as dead space to skip them
6. Click **Export All Tracks** to download a zip of tagged MP3s
