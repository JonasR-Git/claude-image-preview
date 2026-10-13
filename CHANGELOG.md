# Changelog

## 1.1.0 – 2026-10-13

First public release.

- Windows: real pictures over the colored blocks, in the classic console, Git Bash (mintty), Windows
  Terminal, VS Code, WezTerm and Alacritty. A helper finds each tile on the terminal's screen and lays a
  borderless window with the picture at full resolution exactly over its blocks; a click on it opens the
  picture in the default viewer. It follows the window, hides when another one, another tab or the
  scrollback is in front, and ends with the session. It starts with the session and is compiled once per
  version, so pictures show within a fraction of a second of a paste. New option `overlay` (on);
  `/image-preview status` says whether it runs and where its log is.
- Thumbnails have a title row: the label (opens the gallery) on the left, an ✕ that takes the picture out of
  the prompt on the right. The label row under the picture is gone.
- Fewer settings: `labels` and `backdrop` are gone. The label is always in the title row; transparent pixels
  show the terminal's background. Options set for them before are ignored.
- Windows: pastes are found again. Claude Code keeps them in `%TEMP%\claude\…`, not `%TEMP%\claude-0\…`; the
  plugin looked only for the latter and showed "not found" for every pasted or dragged-in picture.
- Sharper thumbnails: a picture may take the whole width of the band instead of 48 columns, and `tile_rows`
  now defaults to its new maximum of 32, so thumbnails are as large as the band allows. Colored blocks show
  two pixels per cell, so size is what decides how much can be seen.
- Git Bash: a picture dragged into the window reaches Claude. mintty types it as its POSIX path
  (`'/c/Users/…/shot.png'`), which Claude Code keeps as text; the plugin turns such a paste into an `@`-mention
  of the Windows path, also when the same file is dropped twice or an `@` was typed first. Absolute image
  paths without an `@` get a thumbnail when the file is there.
- Hardening:
  - The plugin's files, the compiled overlay helper among them, live in the user's own cache folder
    (`%LOCALAPPDATA%\claude-image-preview`, `~/Library/Caches/…`, `~/.cache/…`) instead of a temp folder, and
    pastes are looked for only in this account's `claude-<uid>` folder.
  - PowerShell quoting doubles the typographic quotes PowerShell also ends a string at.
  - Network paths (`\\server\share`) are never opened.
  - Converters get only files marked as pictures by their first bytes or, past 4 MB, their name; ImageMagick
    is told the format, `ffmpeg` may read local files only.
  - A GIF frame larger than the decoder's pixel limit is refused before it is allocated.
  - `/image-open` and a click on a picture open only local picture files.
  - With `read_previews` off, the files Claude reads are left alone.
- Fixes: gallery pictures stay within the 2 MiB an `Image` takes; `/image-open "@path with spaces"` works;
  punctuation after an `@`-mention stays when ✕ takes it out; labels with wide characters fit their row; a
  renderer chosen while the probe runs stands.
- Overlay: the terminal's menus and the input method stay above the picture, unless the terminal itself is
  kept on top; it hides while mintty is scrolled back; see-through pixels sit on dark gray, not black; the
  picture follows a moved window at once; the screenshot route waits longer after each miss; it compiles into
  a path with brackets too, logs a failed start and clears helpers of older versions.

## 1.0.1 – 2026-10-13

- Pastes are found without listing the whole temp folder: `claude-<uid>` is looked up directly (`claude` on
  Windows, the uid from `id -u` elsewhere). Windows temp folders with many thousands of entries no longer slow or
  break the search.
- When the environment names no temp folder, the system is asked (PowerShell on Windows, `getconf` on macOS), and
  `%USERPROFILE%\AppData\Local\Temp` is searched too.
- `/image-preview status` reports the Claude Code version, the pictures in the prompt with their state, the
  `claude-<uid>` folders found, this session's paste folder with its files, and recent paste folders of other
  sessions when this one has none.

## 1.0.0 – 2026-10-12

First release.

- Thumbnails above the prompt for pasted pictures (`[Image #n]`), `@`-mentioned image files and clipboard captures,
  updated within a quarter second of a paste and cleared when the prompt is sent.
- Built-in decoders for PNG, JPEG, GIF, BMP and WebP (lossy, lossless, alpha, animated first frame); HEIC, AVIF,
  TIFF, ICO and files over 4 MB through a converter the system has.
- Real pictures in terminals that draw them, 24-bit half blocks everywhere else, chosen by a probe instead of a
  name list; pixels instead of file paths over SSH.
- `/paste` and `@clipboard`: pictures and copied image files from the clipboard, without saving them first.
- `/image-copy`: a picture onto the clipboard as an image.
- `/images`: a gallery of every picture of the session, including those Claude read, with open, copy, insert and
  copy-path actions.
- `/image-open`: the default viewer.
- `/image-preview`: on/off, renderer choice, diagnostics.
- Thumbnails under pictures Claude opens with the Read tool.
- Windows (PowerShell, no extra tools), macOS, Linux (Wayland and X11) and WSL.
- Settings for renderer, thumbnail height, labels, Read previews and transparency backdrop.
