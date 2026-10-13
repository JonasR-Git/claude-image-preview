// image-preview: real pictures over the colored blocks Claude Code draws on Windows.
//
// Claude Code draws pictures only through the kitty protocol, which no Windows
// terminal speaks, so a thumbnail there is half blocks. This helper reads the
// console's cells, finds each tile's rounded frame by its exact size, and keeps
// a borderless, click-through window with the picture over the blocks.
//
// The mod writes the tiles to a state file, one line each, tab-separated:
// columns, rows, rows above the picture, rows below it, and the picture's path.
//
// Terminals: the classic console (conhost), whose window and font the console
// API reports; mintty (Git Bash), which draws a pseudo console in a window of
// its own with a fixed one-pixel padding; and any terminal that offers its text
// through UI Automation (Windows Terminal), where the control showing the same
// lines as the console says where its first character is. Any other terminal
// (VS Code, WezTerm, Alacritty) is photographed: the frames, drawn in one exact
// color, give the cell size and where the grid starts. Where none of that
// works the blocks stay: a picture beside its tile is worse than none.
//
// A click on a picture opens it in the default viewer, without taking the
// focus from the terminal; the mouse wheel goes on to the terminal.
//
// Nothing is ever written to the console: it is the person's, and output there
// would land in their prompt. Why it stopped goes to a log file beside the
// state file; exit codes: 2 no console, 3 a terminal it cannot place pictures in.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using System.Windows.Forms;

public static class ImagePreviewOverlay {
  // --- Win32 -------------------------------------------------------------

  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct SMALL_RECT { public short Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct CSBI { public COORD Size; public COORD Cursor; public ushort Attributes; public SMALL_RECT Window; public COORD MaxSize; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct FONTEX { public uint Size; public uint Font; public COORD FontSize; public int Family; public int Weight; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Face; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32W {
    public uint Size; public uint Usage; public uint ProcessId; public IntPtr HeapId; public uint ModuleId;
    public uint Threads; public uint ParentId; public int Priority; public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;
  }
  [StructLayout(LayoutKind.Sequential)] struct SCROLLINFO { public uint Size, Mask; public int Min, Max; public uint Page; public int Pos, TrackPos; }
  delegate bool EnumWindowsProc(IntPtr window, IntPtr data);

  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint processId);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool GetConsoleScreenBufferInfo(IntPtr handle, out CSBI info);
  [DllImport("kernel32.dll")] static extern bool GetCurrentConsoleFontEx(IntPtr handle, bool maximum, ref FONTEX font);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool ReadConsoleOutputCharacterW(IntPtr handle, [Out] char[] buffer, uint length, COORD at, out uint read);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder name, int length);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref POINT point);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr window, uint key, byte alpha, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr PostMessageW(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr window, int index);
  [DllImport("user32.dll")] static extern bool GetScrollInfo(IntPtr window, int bar, ref SCROLLINFO info);

  const char TOP_LEFT = (char)0x256D, TOP_RIGHT = (char)0x256E, BOTTOM_LEFT = (char)0x2570, BOTTOM_RIGHT = (char)0x256F;
  const char HORIZONTAL = (char)0x2500, VERTICAL = (char)0x2502, UPPER_HALF = (char)0x2580, LOWER_HALF = (char)0x2584;
  static readonly IntPtr TOPMOST = new IntPtr(-1);
  const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040;

  // --- what to cover -----------------------------------------------------

  class Tile { public int Columns, Rows, Above, Below; public string Path; }

  /** Where the cell grid sits on screen, in pixels; fractions at scales other than 100%. */
  struct Grid { public double X, Y, CellWidth, CellHeight; }

  enum Terminal { Console, Mintty, Text }

  class PictureWindow : Form {
    public Bitmap Picture;
    public string Path;
    public Rectangle Placed = Rectangle.Empty;
    public bool IsShown;
    public PictureWindow() {
      FormBorderStyle = FormBorderStyle.None;
      ShowInTaskbar = false;
      StartPosition = FormStartPosition.Manual;
      BackColor = Color.Black;
      DoubleBuffered = true;
      Cursor = Cursors.Hand;
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get {
        CreateParams p = base.CreateParams;
        // WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_TOPMOST
        p.ExStyle |= 0x08000000 | 0x80 | 0x80000 | 0x8;
        return p;
      }
    }
    protected override void OnHandleCreated(EventArgs e) {
      base.OnHandleCreated(e);
      SetLayeredWindowAttributes(Handle, 0, 255, 2);
    }
    protected override void OnPaint(PaintEventArgs e) {
      if (Picture != null) e.Graphics.DrawImageUnscaled(Picture, 0, 0);
    }
    protected override void WndProc(ref Message m) {
      if (m.Msg == 0x0021) { m.Result = new IntPtr(3); return; } // WM_MOUSEACTIVATE: MA_NOACTIVATE
      if (m.Msg == 0x020A || m.Msg == 0x020E) { // the wheel scrolls the terminal underneath
        PostMessageW(terminalWindow, m.Msg, m.WParam, m.LParam);
        return;
      }
      if (m.Msg == 0x0202) Open(); // WM_LBUTTONUP
      base.WndProc(ref m);
    }
    // The shell opens a file by its name: only a local picture's name is trusted to open a viewer.
    static readonly string[] PICTURE_EXTENSIONS = { ".png", ".apng", ".jpg", ".jpeg", ".jpe", ".jfif", ".gif", ".webp",
      ".bmp", ".dib", ".tif", ".tiff", ".heic", ".heif", ".avif", ".ico" };
    void Open() {
      if (Path == null) return;
      string extension = System.IO.Path.GetExtension(Path).ToLowerInvariant();
      if (Path.StartsWith(@"\\") || Path.StartsWith("//") || Array.IndexOf(PICTURE_EXTENSIONS, extension) < 0) {
        Log("not opened, not a local picture: " + Path);
        return;
      }
      try {
        System.Diagnostics.ProcessStartInfo start = new System.Diagnostics.ProcessStartInfo(Path);
        start.UseShellExecute = true;
        System.Diagnostics.Process.Start(start);
        Log("opened " + Path);
      } catch (Exception error) {
        Log("cannot open " + Path + ": " + error.Message);
      }
    }
  }

  static string statePath, logPath;
  static IntPtr watched = IntPtr.Zero;
  static IntPtr terminalWindow, consoleWindow;
  static Terminal terminal;
  static Timer timer;
  static string stateText;
  static List<Tile> tiles = new List<Tile>();
  static int misses;
  static readonly List<PictureWindow> windows = new List<PictureWindow>();
  static readonly Dictionary<string, Image> pictures = new Dictionary<string, Image>();
  static readonly Dictionary<string, Bitmap> scaled = new Dictionary<string, Bitmap>();

  /** Looks this often while tiles are drawn, and this often while there are none. */
  const int BUSY_MS = 50, IDLE_MS = 250;
  /** Looks that miss a tile before its picture is hidden: rides out a redraw. */
  const int GRACE = 2;

  /**
   * Attaches to the console of the nearest ancestor that has one, works out
   * where that console is drawn and runs until that ancestor exits.
   */
  public static int Run(string state, bool foregroundOnly) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    statePath = state;
    logPath = Path.Combine(Path.GetDirectoryName(state), "overlay.log");
    needsForeground = foregroundOnly;

    Dictionary<uint, uint> parents;
    Dictionary<uint, string> names;
    ReadProcesses(out parents, out names);
    List<uint> chain = new List<uint>();
    uint id = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
    while (chain.Count < 12 && parents.TryGetValue(id, out id) && id != 0 && !chain.Contains(id)) chain.Add(id);

    for (int i = 0; i < chain.Count; i++) {
      FreeConsole();
      if (!AttachConsole(chain[i])) continue;
      consoleWindow = GetConsoleWindow();
      // A pseudo console's window (Windows Terminal, mintty) is hidden, though Windows Terminal's
      // may claim to be visible: its class tells.
      if (consoleWindow != IntPtr.Zero && IsWindowVisible(consoleWindow) && ClassOf(consoleWindow) == "ConsoleWindowClass") {
        terminal = Terminal.Console;
        terminalWindow = consoleWindow;
      } else {
        // A pseudo console: the terminal is a window of a process further up.
        string found;
        IntPtr owner = GetAncestor(consoleWindow, 3);
        if (owner != IntPtr.Zero && owner != consoleWindow && IsWindowVisible(owner) && !IsDesktop(owner)) {
          // Windows Terminal owns the pseudo console's window, whoever started the shell.
          terminalWindow = owner;
          found = ClassOf(owner);
          GetWindowThreadProcessId(owner, out terminalProcess);
        } else {
          terminalWindow = TerminalWindow(chain, i + 1, names, out found);
        }
        if (terminalWindow == IntPtr.Zero && Environment.GetEnvironmentVariable("TERM_PROGRAM") == "mintty") {
          // Git Bash: MSYS cuts the chain of Windows parents short of mintty. Its window is
          // the mintty one in front when the first tile shows: the one a picture went into.
          found = "mintty";
        }
        if (found == "mintty") {
          terminal = Terminal.Mintty;
        } else if (terminalWindow != IntPtr.Zero) {
          terminal = Terminal.Text;
          windowClass = found;
        } else {
          Log("no terminal window around the pseudo console");
          FreeConsole();
          return 3;
        }
      }
      watched = OpenProcess(0x00100000, false, chain[i]); // SYNCHRONIZE
      firstWindow = terminalWindow;
      Log("attached to " + Name(names, chain[i]) + " in " + terminal + (windowClass == null ? "" : " (" + windowClass + ")"));
      break;
    }
    if (watched == IntPtr.Zero) { Log("no console among the ancestors"); return 2; }

    Application.ThreadException += delegate (object sender, System.Threading.ThreadExceptionEventArgs e) {
      Log("error: " + e.Exception.Message);
    };
    timer = new Timer();
    timer.Interval = IDLE_MS;
    timer.Tick += delegate {
      try { Tick(); } catch (Exception error) { Report("error: " + error.Message); HideFrom(0); }
    };
    timer.Start();
    Application.Run();
    FreeConsole();
    return exitCode;
  }

  static int exitCode = 0;

  static bool needsForeground = true;
  static string windowClass;
  /** The process the terminal window belongs to; one process may hold several (VS Code). */
  static uint terminalProcess;
  /** The window found at the start, to fall back to when a followed one closes. */
  static IntPtr firstWindow;

  static void Tick() {
    if (WaitForSingleObject(watched, 0) == 0) { Application.Exit(); return; }
    if (terminalWindow != IntPtr.Zero && !IsWindow(terminalWindow)) {
      if (terminal == Terminal.Mintty) terminalWindow = IntPtr.Zero;
      else if (terminalWindow != firstWindow && IsWindow(firstWindow)) terminalWindow = firstWindow;
      else { Application.Exit(); return; }
      textControl = null;
      isTextAligned = isPixelAligned = false;
    }
    bool isFound = terminalWindow != IntPtr.Zero;
    ReadState();
    timer.Interval = IDLE_MS;
    if (terminal == Terminal.Text && tiles.Count > 0) FollowWindowInFront();
    if (tiles.Count > 0 && !isFound && !FindMintty()) { Report("waiting for its mintty window to be in front"); return; }
    string idle = tiles.Count == 0 ? "no tiles" : IsIconic(terminalWindow) ? "terminal minimized"
      : needsForeground && GetForegroundWindow() != terminalWindow ? "terminal not in front"
      : terminal == Terminal.Mintty && IsScrolledBack(terminalWindow) ? "terminal scrolled back" : null;
    if (idle != null) { Report(idle); HideFrom(0); return; }
    timer.Interval = BUSY_MS;

    char[][] cells = ReadCells();
    Grid grid;
    if (cells == null) { Report("console unreadable"); HideFrom(0); return; }
    if (!Locate(cells, out grid)) { Report("the terminal does not show the console (another tab, scrolled back)"); HideFrom(0); return; }

    int shown = 0, after = -1;
    bool missed = false;
    foreach (Tile tile in tiles) {
      int[] frame = FindFrame(cells, tile, after);
      if (frame == null) { missed = true; continue; }
      after = frame[2];
      Image picture = Load(tile.Path);
      if (picture == null) continue;
      Rectangle place = Cells(grid, frame[1] + 1, frame[0] + 1 + tile.Above, tile.Columns, tile.Rows);
      Place(shown++, tile.Path, picture, place);
    }
    // A redraw can catch the screen half drawn: keep what is shown for a look or two.
    if (missed && shown == 0 && ++misses <= GRACE) return;
    misses = 0;
    HideFrom(shown);
    Report(shown == tiles.Count ? "showing " + shown : "showing " + shown + " of " + tiles.Count + " (the rest not on screen)");
  }

  static string reported;

  /** Logs what the overlay does whenever that changes. */
  static void Report(string state) {
    if (state == reported) return;
    reported = state;
    Log(state);
  }

  /** Whether `window`'s scroll bar is off its end: mintty then shows its scrollback, not the console. */
  static bool IsScrolledBack(IntPtr window) {
    SCROLLINFO info = new SCROLLINFO();
    info.Size = (uint)Marshal.SizeOf(typeof(SCROLLINFO));
    info.Mask = 0x17; // SIF_ALL
    if (!GetScrollInfo(window, 1, ref info) || info.Page == 0) return false; // SB_VERT
    return info.Pos + (int)info.Page <= info.Max;
  }

  /** Of a process with several windows (VS Code), the one in front is the one showing the tiles. */
  static void FollowWindowInFront() {
    IntPtr front = GetForegroundWindow();
    if (front == terminalWindow || front == IntPtr.Zero || terminalProcess == 0) return;
    uint owner;
    GetWindowThreadProcessId(front, out owner);
    if (owner != terminalProcess || GetAncestor(front, 3) != front || !IsWindowVisible(front)) return;
    terminalWindow = front;
    textControl = null;
    isTextAligned = isPixelAligned = false;
    textCheckedAt = pixelCheckedAt = DateTime.MinValue;
    Log("following the window in front of the same process");
  }

  /** Takes the mintty window in front as the terminal when its size fits the console's grid. */
  static bool FindMintty() {
    IntPtr front = GetForegroundWindow();
    StringBuilder name = new StringBuilder(64);
    GetClassNameW(front, name, name.Capacity);
    if (name.ToString() != "mintty") return false;
    char[][] cells = ReadCells();
    RECT client;
    if (cells == null || !GetClientRect(front, out client)) return false;
    int width = client.Right - 2, height = client.Bottom - 2;
    int columns = cells[0].Length, rows = cells.Length;
    int cellWidth = width / columns, cellHeight = height / rows;
    if (cellWidth < 4 || cellHeight < 8 || width - cellWidth * columns >= cellWidth || height - cellHeight * rows >= cellHeight) return false;
    terminalWindow = front;
    Log("took the mintty window in front: " + columns + "x" + rows + " cells of " + cellWidth + "x" + cellHeight);
    return true;
  }

  // --- the console -------------------------------------------------------

  /** The visible cells of the active screen buffer, row by row; null when unreadable. */
  static char[][] ReadCells() {
    IntPtr screen = CreateFileW("CONOUT$", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero); // GENERIC_READ
    if (screen == new IntPtr(-1)) return null;
    try {
      CSBI info;
      if (!GetConsoleScreenBufferInfo(screen, out info)) return null;
      int columns = info.Window.Right - info.Window.Left + 1, rows = info.Window.Bottom - info.Window.Top + 1;
      if (columns <= 0 || rows <= 0) return null;
      char[][] cells = new char[rows][];
      for (int row = 0; row < rows; row++) {
        cells[row] = new char[columns];
        COORD at = new COORD();
        at.X = info.Window.Left;
        at.Y = (short)(info.Window.Top + row);
        uint read;
        ReadConsoleOutputCharacterW(screen, cells[row], (uint)columns, at, out read);
      }
      if (terminal == Terminal.Console) {
        FONTEX font = new FONTEX();
        font.Size = (uint)Marshal.SizeOf(typeof(FONTEX));
        consoleFont = GetCurrentConsoleFontEx(screen, false, ref font) ? font.FontSize : new COORD();
      }
      return cells;
    } finally { CloseHandle(screen); }
  }

  static COORD consoleFont;

  /** Where the grid of `cells` is drawn on screen. */
  /** The screen rectangle of `columns` x `rows` cells from (column, row), edges rounded alike. */
  static Rectangle Cells(Grid grid, int column, int row, int columns, int rows) {
    int left = (int)Math.Round(grid.X + column * grid.CellWidth), top = (int)Math.Round(grid.Y + row * grid.CellHeight);
    int right = (int)Math.Round(grid.X + (column + columns) * grid.CellWidth);
    int bottom = (int)Math.Round(grid.Y + (row + rows) * grid.CellHeight);
    return new Rectangle(left, top, right - left, bottom - top);
  }

  static bool Locate(char[][] cells, out Grid grid) {
    if (terminal == Terminal.Text) {
      // Chromium (VS Code) takes a UI Automation client for a screen reader and may ask to
      // switch modes: such windows are only photographed.
      bool asksText = !isTextGivenUp && !windowClass.StartsWith("Chrome_WidgetWin");
      if (asksText && LocateByText(cells, out grid)) return true;
      if (wasTextFound) { grid = new Grid(); return false; }
      return LocateByPixels(cells, out grid);
    }
    grid = new Grid();
    RECT client;
    if (!GetClientRect(terminalWindow, out client)) return false;
    POINT origin = new POINT();
    ClientToScreen(terminalWindow, ref origin);
    int columns = cells[0].Length, rows = cells.Length;
    if (terminal == Terminal.Console) {
      // conhost draws from the client's corner in its font's cells; the remainder is
      // blank at the right and bottom. A font size that does not fit the client
      // (another DPI) yields to the client's own measure.
      int width = consoleFont.X, height = consoleFont.Y;
      if (width <= 0 || width * columns > client.Right || (client.Right - width * columns) >= width + 24) width = client.Right / columns;
      if (height <= 0 || height * rows > client.Bottom || (client.Bottom - height * rows) >= height) height = client.Bottom / rows;
      grid.X = origin.X;
      grid.Y = origin.Y;
      grid.CellWidth = width;
      grid.CellHeight = height;
    } else {
      // mintty: a one-pixel padding around a grid of whole cells.
      const int padding = 1;
      grid.CellWidth = (client.Right - 2 * padding) / columns;
      grid.CellHeight = (client.Bottom - 2 * padding) / rows;
      grid.X = origin.X + padding;
      grid.Y = origin.Y + padding;
    }
    return grid.CellWidth > 0 && grid.CellHeight > 0;
  }

  /**
   * The frame [top, left, right, bottom] around `tile`, right of column `after`; null when not
   * on screen. The lowest one wins: the live band sits right above the prompt, and a copy
   * left higher up by a redraw is not it.
   */
  static int[] FindFrame(char[][] cells, Tile tile, int after) {
    int height = tile.Above + tile.Rows + tile.Below;
    for (int top = cells.Length - height - 2; top >= 0; top--) {
      char[] line = cells[top];
      for (int left = after + 1; left + tile.Columns + 1 < line.Length; left++) {
        int right = left + tile.Columns + 1, bottom = top + height + 1;
        if (line[left] != TOP_LEFT || line[right] != TOP_RIGHT) continue;
        if (cells[bottom][left] != BOTTOM_LEFT || cells[bottom][right] != BOTTOM_RIGHT) continue;
        bool isFrame = true;
        for (int column = left + 1; column < right && isFrame; column++)
          isFrame = line[column] == HORIZONTAL && cells[bottom][column] == HORIZONTAL;
        // A wide glyph in the title (a Japanese file name) is read as one character, which
        // pulls the right border of that row left: rows of text are held by their left border.
        for (int row = top + 1; row < bottom && isFrame; row++) {
          bool isText = row <= top + tile.Above || row > top + tile.Above + tile.Rows;
          isFrame = cells[row][left] == VERTICAL && (isText || cells[row][right] == VERTICAL);
        }
        if (!isFrame) continue;
        // The picture rows hold the blocks; a placeholder ("...") is not covered.
        bool hasBlocks = false;
        for (int row = top + 1 + tile.Above; row <= top + tile.Above + tile.Rows && !hasBlocks; row++)
          for (int column = left + 1; column < right && !hasBlocks; column++)
            hasBlocks = cells[row][column] == UPPER_HALF || cells[row][column] == LOWER_HALF;
        if (hasBlocks) return new int[] { top, left, right, bottom };
      }
    }
    return null;
  }

  // --- terminals that offer their text through UI Automation --------------

  static AutomationElement textControl;
  static DateTime textCheckedAt = DateTime.MinValue;
  static Grid textGrid;
  static bool isTextAligned;
  static int textMisses;
  static bool wasTextFound;
  static bool isTextGivenUp;
  /** How often the control and its alignment are checked: UI Automation calls cross processes. */
  const int TEXT_CHECK_MS = 400;
  /** Checks with tiles but no control ever showing them before the helper stops asking for text. */
  const int TEXT_GIVE_UP = 5;

  /**
   * Where the grid is drawn: the screen rectangle of the first visible character of
   * the control that shows the same lines as the console. A control that shows
   * other lines (another tab, scrolled back) covers nothing.
   */
  static bool LocateByText(char[][] cells, out Grid grid) {
    // The grid is kept from the client's corner, so a moved window is followed on every look.
    Rectangle client = ClientArea();
    grid = Moved(textGrid, client);
    if ((DateTime.UtcNow - textCheckedAt).TotalMilliseconds < TEXT_CHECK_MS && client.Size == textClient.Size) return isTextAligned;
    textCheckedAt = DateTime.UtcNow;
    textClient = client;
    isTextAligned = false;
    try {
      if (textControl == null || !Shows(textControl, cells)) textControl = FindTextControl(cells);
      if (textControl == null) {
        // A terminal whose text never matched has none to offer; one that did may just show another tab.
        if (!wasTextFound && ++textMisses == TEXT_GIVE_UP) {
          isTextGivenUp = true;
          Log("no text of the " + windowClass + " window matches the console: looking for the frames on screen");
        }
        return false;
      }
      wasTextFound = true;
      TextPattern text = (TextPattern)textControl.GetCurrentPattern(TextPattern.Pattern);
      TextPatternRange first = text.GetVisibleRanges()[0].Clone();
      first.MoveEndpointByRange(TextPatternRangeEndpoint.End, first, TextPatternRangeEndpoint.Start);
      first.ExpandToEnclosingUnit(TextUnit.Character);
      System.Windows.Rect[] rects = first.GetBoundingRectangles();
      if (rects.Length == 0 || rects[0].Width < 2 || rects[0].Height < 4 || rects[0].Width > 64 || rects[0].Height > 128) return false;
      // A wide glyph (a Japanese letter) in the first cell spans two: cells are taller than wide.
      textGrid.X = rects[0].X - client.X;
      textGrid.Y = rects[0].Y - client.Y;
      textGrid.CellWidth = rects[0].Height < rects[0].Width * 1.3 ? rects[0].Width / 2 : rects[0].Width;
      textGrid.CellHeight = rects[0].Height;
      grid = Moved(textGrid, client);
      isTextAligned = true;
      return true;
    } catch (Exception) {
      // Gone, busy or timed out: asked again on the next check.
      textControl = null;
      return false;
    }
  }

  static Rectangle textClient;

  /** The terminal's client area on screen; empty when the window is gone. */
  static Rectangle ClientArea() {
    RECT client;
    if (!GetClientRect(terminalWindow, out client)) return Rectangle.Empty;
    POINT origin = new POINT();
    ClientToScreen(terminalWindow, ref origin);
    return new Rectangle(origin.X, origin.Y, client.Right, client.Bottom);
  }

  /** `grid`, kept from the client's corner, on screen. */
  static Grid Moved(Grid grid, Rectangle client) {
    grid.X += client.X;
    grid.Y += client.Y;
    return grid;
  }

  static AutomationElement FindTextControl(char[][] cells) {
    AutomationElement root = AutomationElement.FromHandle(terminalWindow);
    Condition visibleText = new AndCondition(
      new PropertyCondition(AutomationElement.IsTextPatternAvailableProperty, true),
      new PropertyCondition(AutomationElement.IsOffscreenProperty, false));
    foreach (AutomationElement candidate in root.FindAll(TreeScope.Descendants, visibleText))
      if (Shows(candidate, cells)) {
        Log("following the text of " + candidate.Current.ClassName + " '" + candidate.Current.Name + "'");
        return candidate;
      }
    return null;
  }

  /** Whether `control` shows the console's lines: most of the lines with text, in place. */
  static bool Shows(AutomationElement control, char[][] cells) {
    if (control.Current.IsOffscreen) return false;
    TextPattern text = (TextPattern)control.GetCurrentPattern(TextPattern.Pattern);
    TextPatternRange[] visible = text.GetVisibleRanges();
    if (visible.Length == 0) return false;
    string[] lines = visible[0].GetText(-1).Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
    int withText = 0, same = 0;
    for (int row = 0; row < cells.Length; row++) {
      string mine = new string(cells[row]).TrimEnd(' ', (char)0);
      if (mine.Length == 0) continue;
      withText++;
      if (row < lines.Length && lines[row].TrimEnd(' ', (char)0) == mine) same++;
    }
    return withText >= 2 && same * 10 >= withText * 6;
  }

  // --- any other terminal: the frames on a screenshot -------------------------

  /** The frame color the mod draws (ui/band.tsx FRAME_COLOR), and how far a pixel may be off it. */
  const int FRAME_RED = 0x8B, FRAME_GREEN = 0x8B, FRAME_BLUE = 0x99, FRAME_TOLERANCE = 8;
  /** The shortest run of frame pixels that counts as a frame line. */
  const int FRAME_MIN_RUN = 20;
  static Grid pixelGrid;
  static bool isPixelAligned, wasPixelFound;
  static DateTime pixelCheckedAt = DateTime.MinValue;
  static Rectangle pixelWindow = Rectangle.Empty;
  static int pixelMisses, pixelFailures;

  /**
   * Where the grid is drawn, from the frames on a screenshot of the terminal: the
   * outer frame lines run through the middle of known cells, so their distance
   * gives the cell size and their place the grid's corner.
   */
  static bool LocateByPixels(char[][] cells, out Grid grid) {
    Rectangle where = ClientArea();
    grid = Moved(pixelGrid, where);
    // Found, it is checked now and then; not found, each miss waits longer, up to two seconds:
    // a screenshot costs.
    int wait = isPixelAligned ? TEXT_CHECK_MS : Math.Min(2000, TEXT_CHECK_MS * (1 + pixelFailures));
    if ((DateTime.UtcNow - pixelCheckedAt).TotalMilliseconds < wait && where.Size == pixelWindow.Size) return isPixelAligned;
    pixelCheckedAt = DateTime.UtcNow;
    List<int[]> frames = Frames(cells);
    if (frames.Count == 0 || where.Width < 32 || where.Height < 32) {
      isPixelAligned = false;
      return false;
    }
    RECT client = new RECT();
    client.Right = where.Width;
    client.Bottom = where.Height;
    POINT origin = new POINT();
    origin.X = where.X;
    origin.Y = where.Y;
    List<int> edgeColumns = new List<int>(), edgeRows = new List<int>();
    int firstRow = int.MaxValue, lastRow = 0;
    foreach (int[] frame in frames) {
      AddOnce(edgeColumns, frame[1]);
      AddOnce(edgeColumns, frame[2]);
      AddOnce(edgeRows, frame[0]);
      AddOnce(edgeRows, frame[3]);
      firstRow = Math.Min(firstRow, frame[0]);
      lastRow = Math.Max(lastRow, frame[3]);
    }
    // Once found, only the strip the frames lie in is photographed, with some cells to spare.
    int stripTop = 0, stripBottom = client.Bottom;
    if (isPixelAligned && where.Size == pixelWindow.Size) {
      stripTop = Math.Max(0, (int)(pixelGrid.Y + (firstRow - 3) * pixelGrid.CellHeight));
      stripBottom = Math.Min(client.Bottom, (int)(pixelGrid.Y + (lastRow + 4) * pixelGrid.CellHeight));
      if (stripBottom - stripTop < FRAME_MIN_RUN * 2) { stripTop = 0; stripBottom = client.Bottom; }
    }
    List<double> columns, rows;
    using (Bitmap shot = new Bitmap(client.Right, stripBottom - stripTop, PixelFormat.Format32bppRgb)) {
      using (Graphics g = Graphics.FromImage(shot)) g.CopyFromScreen(origin.X, origin.Y + stripTop, 0, 0, shot.Size);
      FrameLines(shot, out columns, out rows);
    }
    for (int i = 0; i < rows.Count; i++) rows[i] += stripTop;
    double cellWidth, left, cellHeight = 0, top = 0;
    bool fits = Fit(columns, edgeColumns, 4, 64, out cellWidth, out left) && Fit(rows, edgeRows, 8, 128, out cellHeight, out top);
    double shape = fits ? cellHeight / cellWidth : 0;
    if (shape < 1.2 || shape > 3.5) {
      // A redraw can catch the frames half drawn: what was found holds for two looks in an unmoved window.
      if (isPixelAligned && where.Size == pixelWindow.Size && ++pixelMisses <= 2) return true;
      isPixelAligned = false;
      pixelFailures++;
      return false;
    }
    pixelMisses = pixelFailures = 0;
    pixelWindow = where;
    pixelGrid.CellWidth = cellWidth;
    pixelGrid.CellHeight = cellHeight;
    pixelGrid.X = left;
    pixelGrid.Y = top;
    if (!wasPixelFound) Log("found the frames on screen: cells of " + cellWidth.ToString("0.##") + "x" + cellHeight.ToString("0.##"));
    wasPixelFound = true;
    isPixelAligned = true;
    grid = Moved(pixelGrid, where);
    return true;
  }

  /** The frames of the tiles on screen, as FindFrame gives them, left to right. */
  static List<int[]> Frames(char[][] cells) {
    List<int[]> frames = new List<int[]>();
    int after = -1;
    foreach (Tile tile in tiles) {
      int[] frame = FindFrame(cells, tile, after);
      if (frame == null) continue;
      after = frame[2];
      frames.Add(frame);
    }
    return frames;
  }

  static void AddOnce(List<int> list, int value) {
    if (!list.Contains(value)) list.Add(value);
  }

  /**
   * The cell size and grid start that put the most `edges` (cells whose middle a frame line runs
   * through) on found `lines`. Every pair of lines is tried as every pair of edges, so a frame
   * that is not on screen, a placeholder's frame or a gray line elsewhere does not skew it.
   * False unless all edges, or all but one of three or more, land on a line.
   */
  static bool Fit(List<double> lines, List<int> edges, double min, double max, out double cell, out double start) {
    cell = start = 0;
    int best = 0;
    double bestError = double.MaxValue;
    if (lines.Count < 2 || edges.Count < 2 || lines.Count > 64) return false;
    for (int a = 0; a < edges.Count; a++)
      for (int b = 0; b < edges.Count; b++) {
        if (edges[b] <= edges[a]) continue;
        for (int i = 0; i < lines.Count; i++)
          for (int j = i + 1; j < lines.Count; j++) {
            double size = (lines[j] - lines[i]) / (edges[b] - edges[a]);
            if (size < min || size > max) continue;
            double origin = lines[i] - (edges[a] + 0.5) * size;
            int hits = 0;
            double error = 0;
            foreach (int edge in edges) {
              double expected = origin + (edge + 0.5) * size, nearest = double.MaxValue;
              foreach (double line in lines) nearest = Math.Min(nearest, Math.Abs(line - expected));
              if (nearest <= 1.5) { hits++; error += nearest; }
            }
            if (hits > best || (hits == best && error < bestError)) {
              best = hits;
              bestError = error;
              cell = size;
              start = origin;
            }
          }
      }
    return best >= (edges.Count >= 3 ? edges.Count - 1 : edges.Count);
  }

  /** The middles of the vertical and horizontal lines drawn in the frame color, left to right and top down. */
  static void FrameLines(Bitmap shot, out List<double> columns, out List<double> rows) {
    int width = shot.Width, height = shot.Height;
    BitmapData data = shot.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
    byte[] pixels = new byte[data.Stride * height];
    Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
    int stride = data.Stride;
    shot.UnlockBits(data);
    bool[] isFrame = new bool[width * height];
    for (int y = 0; y < height; y++)
      for (int x = 0; x < width; x++) {
        int at = y * stride + x * 4;
        isFrame[y * width + x] = Math.Abs(pixels[at + 2] - FRAME_RED) <= FRAME_TOLERANCE
          && Math.Abs(pixels[at + 1] - FRAME_GREEN) <= FRAME_TOLERANCE && Math.Abs(pixels[at] - FRAME_BLUE) <= FRAME_TOLERANCE;
      }
    bool[] isColumn = new bool[width], isRow = new bool[height];
    for (int x = 0; x < width; x++) {
      int run = 0;
      for (int y = 0; y < height && !isColumn[x]; y++) { run = isFrame[y * width + x] ? run + 1 : 0; isColumn[x] = run >= FRAME_MIN_RUN; }
    }
    for (int y = 0; y < height; y++) {
      int run = 0;
      for (int x = 0; x < width && !isRow[y]; x++) { run = isFrame[y * width + x] ? run + 1 : 0; isRow[y] = run >= FRAME_MIN_RUN; }
    }
    columns = Middles(isColumn);
    rows = Middles(isRow);
  }

  /** The middle of each run of trues: a line one or two pixels thick is one line. */
  static List<double> Middles(bool[] marks) {
    List<double> middles = new List<double>();
    for (int i = 0; i < marks.Length; i++) {
      if (!marks[i]) continue;
      int start = i;
      while (i + 1 < marks.Length && marks[i + 1]) i++;
      middles.Add((start + i) / 2.0 + 0.5);
    }
    return middles;
  }

  static bool IsDesktop(IntPtr window) {
    string name = ClassOf(window);
    return name == "Progman" || name == "WorkerW" || name == "Shell_TrayWnd";
  }

  static string ClassOf(IntPtr window) {
    StringBuilder name = new StringBuilder(128);
    GetClassNameW(window, name, name.Capacity);
    return name.ToString();
  }

  // --- the pictures ------------------------------------------------------

  static void Place(int index, string path, Image picture, Rectangle place) {
    while (windows.Count <= index) {
      PictureWindow created = new PictureWindow();
      IntPtr handle = created.Handle;
      windows.Add(created);
    }
    PictureWindow window = windows[index];
    window.Path = path;
    Bitmap bitmap = Scaled(path, picture, place.Size);
    if (window.Picture != bitmap) {
      window.Picture = bitmap;
      window.Invalidate();
    }
    if (window.Placed != place || !window.IsShown) {
      SetWindowPos(window.Handle, TOPMOST, place.X, place.Y, place.Width, place.Height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
      window.Placed = place;
      window.IsShown = true;
    } else if ((GetWindowLongW(terminalWindow, -20) & 0x8) != 0) { // GWL_EXSTYLE has WS_EX_TOPMOST
      // A terminal kept on top (Windows Terminal's alwaysOnTop) rises above the picture when activated.
      // Any other is left alone, so its menus and the input method's window stay above the picture.
      SetWindowPos(window.Handle, TOPMOST, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
    }
  }

  static void HideFrom(int index) {
    for (int i = index; i < windows.Count; i++) {
      if (!windows[i].IsShown) continue;
      ShowWindow(windows[i].Handle, 0);
      windows[i].IsShown = false;
    }
  }

  /** The picture scaled once to `size`, smoothly. */
  static Bitmap Scaled(string path, Image picture, Size size) {
    string key = path + "|" + size.Width + "x" + size.Height;
    Bitmap bitmap;
    if (scaled.TryGetValue(key, out bitmap)) return bitmap;
    bitmap = new Bitmap(size.Width, size.Height);
    using (Graphics g = Graphics.FromImage(bitmap))
    using (ImageAttributes edges = new ImageAttributes()) {
      g.InterpolationMode = InterpolationMode.HighQualityBicubic;
      g.PixelOffsetMode = PixelOffsetMode.HighQuality;
      g.CompositingQuality = CompositingQuality.HighQuality;
      edges.SetWrapMode(WrapMode.TileFlipXY);
      // See-through pixels sit on the dark gray the blocks mix part see-through ones with (view/raster.ts UNDER).
      g.Clear(Color.FromArgb(30, 30, 30));
      g.DrawImage(picture, new Rectangle(Point.Empty, size), 0, 0, picture.Width, picture.Height, GraphicsUnit.Pixel, edges);
    }
    if (scaled.Count >= 24) {
      // Frees the copies no window shows; a resize makes a new one every look.
      Dictionary<string, Bitmap> shown = new Dictionary<string, Bitmap>();
      foreach (KeyValuePair<string, Bitmap> entry in scaled) {
        bool isShown = false;
        foreach (PictureWindow window in windows) isShown |= window.Picture == entry.Value;
        if (isShown) shown[entry.Key] = entry.Value;
        else entry.Value.Dispose();
      }
      scaled.Clear();
      foreach (KeyValuePair<string, Bitmap> entry in shown) scaled[entry.Key] = entry.Value;
    }
    scaled[key] = bitmap;
    return bitmap;
  }

  /** The picture at `path`, decoded once per change of the file; null when unreadable. */
  static Image Load(string path) {
    DateTime time;
    try { time = File.GetLastWriteTimeUtc(path); } catch { return null; }
    string key = path + "|" + time.Ticks;
    Image picture;
    if (pictures.TryGetValue(key, out picture)) return picture;
    picture = Decode(path);
    if (pictures.Count >= 8) {
      // Only the scaled copies are shown, so the decoded pictures can go.
      foreach (Image old in pictures.Values) if (old != null) old.Dispose();
      pictures.Clear();
    }
    pictures[key] = picture;
    return picture;
  }

  /** The largest side a decoded picture keeps: a tile is never larger than the screen. */
  const int MAX_SIDE = 2048;

  static Image Decode(string path) {
    try {
      byte[] bytes = File.ReadAllBytes(path);
      try {
        using (MemoryStream stream = new MemoryStream(bytes))
        using (Bitmap decoded = new Bitmap(stream)) return Capped(decoded);
      } catch (ArgumentException) {
        // Not a format GDI+ reads (WebP, HEIC): Windows Imaging Component, with whatever codecs are installed.
        return DecodeWithWic(bytes);
      }
    } catch (Exception error) {
      Log("cannot read " + path + ": " + error.Message);
      return null;
    }
  }

  static Image DecodeWithWic(byte[] bytes) {
    using (MemoryStream input = new MemoryStream(bytes)) {
      var decoder = System.Windows.Media.Imaging.BitmapDecoder.Create(input,
        System.Windows.Media.Imaging.BitmapCreateOptions.None, System.Windows.Media.Imaging.BitmapCacheOption.OnLoad);
      var encoder = new System.Windows.Media.Imaging.PngBitmapEncoder();
      encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(decoder.Frames[0]));
      using (MemoryStream png = new MemoryStream()) {
        encoder.Save(png);
        png.Position = 0;
        using (Bitmap decoded = new Bitmap(png)) return Capped(decoded);
      }
    }
  }

  /** A copy of `decoded` that owns its pixels, at most MAX_SIDE on its longer side. */
  static Bitmap Capped(Bitmap decoded) {
    double scale = Math.Min(1.0, (double)MAX_SIDE / Math.Max(decoded.Width, decoded.Height));
    if (scale >= 1.0) return new Bitmap(decoded);
    Size size = new Size(Math.Max(1, (int)(decoded.Width * scale)), Math.Max(1, (int)(decoded.Height * scale)));
    Bitmap smaller = new Bitmap(size.Width, size.Height);
    using (Graphics g = Graphics.FromImage(smaller)) {
      g.InterpolationMode = InterpolationMode.HighQualityBicubic;
      g.PixelOffsetMode = PixelOffsetMode.HighQuality;
      g.DrawImage(decoded, new Rectangle(Point.Empty, size));
    }
    return smaller;
  }

  // --- the state file ----------------------------------------------------

  /**
   * Reads the tiles when the file's text changed. Every line ends with a newline, and no tiles is
   * a lone one, so a text without one at its end is caught mid-write and read again on the next look.
   */
  static void ReadState() {
    string text;
    try { text = File.ReadAllText(statePath, Encoding.UTF8); } catch (IOException) { return; } catch (UnauthorizedAccessException) { return; }
    if (text == stateText || text.Length == 0 || text[text.Length - 1] != (char)10) return;
    List<Tile> read = new List<Tile>();
    try {
      foreach (string line in text.Split((char)10)) {
        string[] parts = line.Split((char)9);
        if (parts.Length != 5) continue;
        Tile tile = new Tile();
        tile.Columns = int.Parse(parts[0]);
        tile.Rows = int.Parse(parts[1]);
        tile.Above = int.Parse(parts[2]);
        tile.Below = int.Parse(parts[3]);
        tile.Path = parts[4];
        read.Add(tile);
      }
    } catch (FormatException) {
      return;
    }
    stateText = text;
    tiles = read;
  }

  // --- processes and windows ---------------------------------------------

  static void ReadProcesses(out Dictionary<uint, uint> parents, out Dictionary<uint, string> names) {
    parents = new Dictionary<uint, uint>();
    names = new Dictionary<uint, string>();
    IntPtr snapshot = CreateToolhelp32Snapshot(0x2, 0);
    if (snapshot == new IntPtr(-1)) return;
    try {
      PROCESSENTRY32W entry = new PROCESSENTRY32W();
      entry.Size = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
      for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) {
        parents[entry.ProcessId] = entry.ParentId;
        names[entry.ProcessId] = entry.ExeFile;
      }
    } finally { CloseHandle(snapshot); }
  }

  static string Name(Dictionary<uint, string> names, uint id) {
    string name;
    return names.TryGetValue(id, out name) ? name + " (" + id + ")" : id.ToString();
  }

  /** The visible top-level window of the first of `chain[from..]` that has one, and its class. */
  static IntPtr TerminalWindow(List<uint> chain, int from, Dictionary<uint, string> names, out string className) {
    className = null;
    Dictionary<uint, IntPtr> byProcess = new Dictionary<uint, IntPtr>();
    Dictionary<uint, int> areas = new Dictionary<uint, int>();
    EnumWindows(delegate (IntPtr window, IntPtr data) {
      if (!IsWindowVisible(window) || GetAncestor(window, 3) != window) return true;
      RECT rect;
      GetClientRect(window, out rect);
      int area = rect.Right * rect.Bottom;
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      int known;
      if (area > 0 && (!areas.TryGetValue(owner, out known) || area > known)) {
        areas[owner] = area;
        byProcess[owner] = window;
      }
      return true;
    }, IntPtr.Zero);
    for (int i = from; i < chain.Count; i++) {
      string exe;
      // Started from the desktop: nothing above holds the terminal's window.
      if (names.TryGetValue(chain[i], out exe) && string.Equals(exe, "explorer.exe", StringComparison.OrdinalIgnoreCase)) break;
      IntPtr window;
      if (!byProcess.TryGetValue(chain[i], out window) || IsDesktop(window)) continue;
      terminalProcess = chain[i];
      StringBuilder name = new StringBuilder(128);
      GetClassNameW(window, name, name.Capacity);
      className = name.ToString();
      return window;
    }
    return IntPtr.Zero;
  }

  /** Appends to the log, which starts over past 256 KB. */
  static void Log(string line) {
    try {
      FileInfo log = new FileInfo(logPath);
      if (log.Exists && log.Length > 256 * 1024) log.Delete();
      File.AppendAllText(logPath, DateTime.Now.ToString("HH:mm:ss ") + line + Environment.NewLine);
    } catch { }
  }
}
