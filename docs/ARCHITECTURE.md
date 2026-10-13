# Architecture

Image Preview is a Claude Code mod: TypeScript that Claude Code loads into its own runtime, with no Node, no
package and no build step. The mods API (`$`) is the only way out of that runtime, so the design rule is simple:
**one file talks to Claude Code, everything else is plain code that gets the outside world passed in.**

```
hooks/
  register.tsx        the only user of `$`: hooks, $.state, commands, renderer probe
  ui/                 pure element trees: band (above the prompt), gallery (pane)
  lib/
    service/          what the commands and the band need, against a Host interface
      host.ts           files, processes and the clock as plain functions
      system.ts         platform, helper tools, WSL path mapping (learned lazily)
      locator.ts        where Claude Code stores this session's pastes
      pictures.ts       reference → PreviewItem + cached thumbnail; converter fallback
      clipboard.ts      pictures out of and into the system clipboard
      convert.ts        HEIC/AVIF/TIFF/ICO/huge files → PNG with a tool the system has
      viewer.ts         open in the default viewer
      session.ts        per-session state: draft, clipboard capture, housekeeping, diagnostics
      settings.ts       userConfig → typed settings
    platform/         OS detection, path styles, the exact commands per platform
    prompt/           parsing `[Image #n]` and `@mentions` out of the draft
    codec/            dependency-free decoders: inflate, PNG, JPEG, GIF, BMP, WebP
    view/             layout in character cells, labels, half-block rasters
types/index.d.ts      the $.state contract
tests/                unit, service (fake host) and mod tests (claude plugin test)
```

## Data flow

1. **Poll.** Pasting an image raises no prompt event, so a 250 ms `$.clock.every` reads the prompt box. When the
   text is unchanged nothing else happens.
2. **Parse.** `prompt/draft.ts` finds `[Image #n]` and image `@mentions` (quoted, `~`, relative, with `#L` ranges)
   in order, each once, and absolute image paths written without an `@`, which show only when the file is there.
   A share (`\\host\share`) is never opened: even a look at one sends the account's credentials to its host.
3. **Locate.** `[Image #n]` is mapped to `<tmp>/claude-<uid>/<project>/<session>/images/<n>.<ext>`. The
   `claude-<uid>` folder is looked up by name (plain `claude` on Windows, which has no uid; the uid from `id -u` elsewhere) rather than by
   listing the temp folder, which can hold tens of thousands of entries; when the environment names no temp folder
   the system is asked. The project key is guessed from the working directory and, when that misses (long paths are cut and hashed), the session id
   is searched under every `claude-<uid>` root. A resumed session numbers pastes from 1 again, so the newest file
   of a number wins. A paste that is not on disk yet is shown as loading and checked again.
4. **Describe and decode.** `PictureStore` stats the file; size and mtime key a cache, so an unchanged picture
   costs one stat. New content is sniffed, decoded straight to a 256 px thumbnail (JPEG uses scaled IDCT, PNG and
   WebP downsample while decoding) and kept in a small LRU. Formats without a decoder go through a converter into
   the mod's own work folder; only a file whose first bytes (or, past 4 MB, whose name) mark it as a picture is
   handed to one. The gallery decodes a larger rendition, at most 1024 px and 2 MiB of pixels, once per size.
5. **State.** The facts (`PreviewItem`: label, size, format, status, revision) go into `$.state` atoms; pixels stay
   in module memory. Writing an atom redraws the band and the gallery.
6. **Draw.** The band lays the tiles out in the columns and rows the prompt area offers, shrinking tiles before
   dropping any, and draws each as an `Image` (real pixels) or a `Raster` of half blocks (two pixels per cell, 24-bit
   color). A picture whose pixels left the cache is decoded again in the background and swapped in place.
   After a picture is taken out the others keep their height (`HeldHeight`) until five seconds pass without
   another removal, the band's width changes or it empties.

## Renderer choice

Claude Code does not tell a mod whether its `Image` element shows pixels in the current terminal. The mod starts
from the terminal's name (kitty, Ghostty; never inside tmux or screen) and then asks: `$.ui.blit` on a drawn image
answers with a refusal reason when the terminal shows the alt text instead, or when it cannot read local files
(SSH). The answer switches the renderer to half blocks or to sending pixels instead of file paths. Settings and
`/image-preview pictures|blocks|auto` override the guess.

## Overlay on Windows

Claude Code draws pictures only through the kitty protocol, which no Windows terminal speaks, so a thumbnail
there is colored blocks. `service/overlay.ts` starts a helper with the session through `$.process.spawn`:
`platform/overlay.cs`, compiled by the C# compiler of .NET Framework (called directly: `Add-Type` cannot
write to a path with brackets) into the work root once per hash of its source and loaded from there
afterwards; helpers of older versions are deleted then, and a failure before the helper runs is written to its
log. The work root is the user's own cache folder (`%LOCALAPPDATA%\claude-image-preview`), never a temp
folder other accounts can write to, since what is cached there gets loaded and run. The mod writes the tiles
drawn as blocks to `overlay.tsv` in the work folder, one line each: columns, rows, rows of the tile above and
below the picture (the title row above), path. No tiles is a lone newline, so an empty file is one caught
mid-write.

The helper walks its ancestors (a Toolhelp snapshot) and attaches to the first console it can. A visible
console window is conhost: cells map to pixels by the console font, checked against the client size. A hidden
one is a pseudo console, and the terminal is the window of a process further up: mintty draws whole cells
inside a one-pixel padding. In Git Bash MSYS cuts the chain of Windows parents short of mintty; with
`TERM_PROGRAM=mintty` the helper takes the mintty window in front when the first tile shows, if its size
fits the console's grid. Windows Terminal owns its pseudo console's window, which may even claim to be
visible, so conhost is told by its class (`ConsoleWindowClass`). Any other terminal window is asked through
UI Automation: among its visible controls with a TextPattern, the one whose visible lines match most of the
console's lines is followed, and the screen rectangle of its first visible character gives the grid. A
control showing other lines (another tab, the scrollback) covers nothing.

Both grids are kept from the client area's corner, so a moved window is followed on the next look; a
resize checks again. A wide glyph in the first cell, which spans two, is halved.

A terminal whose text never matches (WezTerm, Alacritty), and any Chromium window (VS Code, which takes a
UI Automation client for a screen reader), is photographed instead: the band draws its frames in one exact
color (`FRAME_COLOR`, light enough that VS Code's minimum contrast leaves it alone on a dark theme, and the
same under the pointer), the helper finds the vertical and horizontal runs of that color, and fits the grid
to them: frame lines run through the middle of known cells, so every pair of lines is tried as every pair
of frame edges, and the cell size and corner that put the most edges on a line win. A placeholder's frame,
a frame off screen or a gray line elsewhere does not skew it. Once found, only the strip the band lies in is
photographed; a redraw that catches the frames half drawn is ridden out for two looks in an unmoved window.
While no fit is found, each try waits longer, up to two seconds.
Of a process with several windows the one in front is followed, and the first one taken again when it
closes. A shell started from Explorer has `explorer.exe` above it: the desktop is never taken for the
terminal. Without a terminal window at all the helper ends with exit code 3 and is not started again; a
picture beside its tile would be worse than none.

Every 50 ms while there are tiles (250 ms otherwise) it reads the visible cells with
`ReadConsoleOutputCharacterW`, finds each tile's rounded frame by its exact inner size with blocks inside,
the lowest first (the live band sits right above the prompt; a copy left higher by a redraw is not it), and
keeps a borderless window (no activation, topmost) with the picture over the blocks, decoded at most 2048
pixels wide, scaled once, bicubic, see-through pixels on the dark gray the blocks use; WebP and HEIC go
through the Windows Imaging Component. It is raised again each look only above a terminal that is itself
kept on top, so the terminal's menus and the input method's window stay above it otherwise. The state file is read by its text, so two writes within one clock tick are both seen. A frame
missing for two looks hides its picture, so a redraw does not make it flicker. It hides while the
terminal is not in front, minimized or (mintty) scrolled back, looks only four times a second then, and
exits with the process it attached through. It never writes to the console, whose output would land in
the person's prompt: what it does goes to `overlay.log` beside the state file, each change once, and the
log starts over past 256 KB. A click on a picture opens it through the shell, if its name is that of a
local picture file; the mouse wheel is posted on to the terminal window.

A paste that is nothing but Git Bash paths of image files (`prompt.edit` without a key) is rewritten into
`@`-mentions of the Windows paths before it reaches the box: Claude Code turns a dropped Windows path into
`[Image #n]` itself, but leaves mintty's POSIX paths as text.

## Platform layer

- **Commands are argument vectors.** No path is ever spliced into a shell string: POSIX helpers run as
  `sh -c '<fixed script>' sh <path>`; PowerShell scripts travel as `-EncodedCommand` (UTF-16LE base64) with paths
  as single-quoted literals. Windows clipboard access runs with `-Sta`.
- **Windows** uses only what ships with it: PowerShell, `System.Windows.Forms.Clipboard` and the Windows Imaging
  Component for conversion. Paths keep their backslashes and drive letters; the temp root is `%TEMP%\claude`.
- **WSL** talks to the Windows clipboard through `powershell.exe` and maps paths with `wslpath`.
- **macOS** uses `osascript` (JavaScript for Automation, NSPasteboard) and `sips`.
- **Linux** uses `wl-paste`/`wl-copy` on Wayland or `xclip` on X11, and any converter it finds.
- Helper tools are looked up once per session, only when a feature needs them.

## Decoders

Everything that can be decoded in-process is, so the common case starts no process at all:

- `inflate.ts`: zlib/deflate, streaming, fixed and dynamic Huffman.
- `png.ts`: all color types and bit depths, `tRNS`, Adam7, downsampling row by row while decoding.
- `jpeg.ts`: baseline and progressive Huffman, restart markers, scaled IDCT (1/2, 1/4, 1/8), bilinear chroma
  upsampling, CMYK and YCCK, EXIF orientation.
- `gif.ts`: LZW, first frame, transparency, interlacing.
- `bmp.ts`: 1/4/8/16/24/32 bit, bitfields, RLE4/RLE8, top-down and bottom-up.
- `webp.ts`: VP8L (all transforms, color cache, meta prefix codes), VP8 (intra prediction, loop filter; skipped
  when shrinking a lot), `ALPH`, and the first `ANMF` frame.

Decoders take a `maxSide` and produce the thumbnail directly, so a 12-megapixel photo never exists at full size in
memory.

## Hooks and failure

- Gating hooks (`prompt.submit`, `tool.call`, `classic.SessionStart`) carry `.catch` handlers that fall through to
  `next(e)`: a bug in the mod can never block a prompt or a tool.
- Render hooks read their atoms before any early return, so a hidden band still subscribes to the values that
  will show it again.
- Every command is registered on its own, so a name another plugin holds costs only that command.
- `@clipboard` in a sent prompt is replaced by the captured file's mention; with nothing on the clipboard the
  prompt is kept in the box and the reason is shown instead of sending a dangling word.

## Testing

- `tests/codec.test.ts`: exact pixels against fixtures written by Pillow (`scripts/make-fixtures.py`), every PNG
  type, JPEG baseline/progressive/subsampling/CMYK/orientation, GIF, BMP variants, nine WebP variants.
- `tests/services.test.ts`: Windows, macOS, Linux and WSL against an in-memory host (`tests/fake-host.ts`):
  temp folders, user names with spaces, long project paths, resumed sessions, clipboard tools per platform.
- `tests/mod.test.ts`: the mod as Claude Code runs it (`claude-code/testing`): the band appears on a paste and
  clears on send, commands, the gallery, `@clipboard`, the ✕.
- `tests/windows.test.ts`: the mod on a Windows host: a dragged picture, a Git Bash drop, a dragged path.
- `tests/overlay.test.ts`: the overlay's state file, its start, its end for good or its restart, the script.
- `tests/units.test.ts`: draft parsing and the Git Bash rewrite, layout, labels, paths, platform guesses,
  PowerShell quoting, settings.

Run them with `claude plugin test .`. The C# helper is compiled by CI on Windows.
