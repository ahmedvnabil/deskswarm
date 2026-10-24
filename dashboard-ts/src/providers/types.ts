/** Machine lifecycle, native control, storage and files owned by a provider. */

export interface MachineState {
  desktop_state: string;
}

export interface HomeEntry {
  name: string;
  type: string;
  size: number;
}

export interface ExecResult {
  ok: boolean;
  exit_code: number | null;
  output: string;
}

export interface Inventory {
  os?: string | null;
  kernel?: string | null;
  runtimes?: { name: string; version: string }[];
  apps?: string[];
  package_count?: number | null;
  python_packages?: string[];
  disk?: string | null;
  memory?: string | null;
  error?: string;
}

export interface MachineProvider {
  /** Stored on each machine's row, so a mixed fleet knows who owns what. */
  readonly name: string;

  // ------------------------------------------------------------ lifecycle
  createComputer(
    slug: string,
    screenPort: number,
    password: string,
    image?: string | null,
  ): Promise<void>;
  destroyComputer(slug: string, keepHome?: boolean): Promise<void>;
  containerState(slug: string): Promise<MachineState>;
  suspendComputer(slug: string): Promise<void>;
  resumeComputer(slug: string): Promise<void>;
  isRunning(slug: string): Promise<boolean>;

  // ------------------------------------------------------------ addressing
  driverCall(slug: string, tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<any>;
  novncUrl(port: number, password?: string | null, host?: string | null): string;
  nextNovncPort(reserved: Iterable<number>): Promise<number>;

  // ------------------------------------------------------------- capacity
  /** Machines actually running. null when the backend cannot say — the memory
   *  guard then over-counts, which is the safe direction. */
  awakeMachineCount(): Promise<number | null>;
  /** Browsers with this machine's screen open, or null if it is asleep. */
  vncWatchers(slug: string): Promise<number | null>;
  homeSizeMb(slug: string): Promise<number | null>;

  // ------------------------------------------------------------ snapshots
  snapshotComputer(slug: string, tag: string): Promise<string>;
  removeImage(image: string): Promise<void>;

  // ------------------------------------------------------------- driving
  execInDesktopResult(slug: string, command: string): Promise<ExecResult>;
  getInventory(slug: string): Promise<Inventory>;
  getClipboard(slug: string): Promise<string>;
  setClipboard(slug: string, text: string): Promise<void>;
  pasteText(slug: string, text: string): Promise<void>;
  /** Start a program on the machine's own desktop session. */
  launchApp(slug: string, app: string, args?: string[]): Promise<void>;

  // ---------------------------------------------------------------- files
  listHome(slug: string, rel?: string): Promise<HomeEntry[]>;
  uploadToHome(
    slug: string,
    relDir: string,
    filename: string,
    data: Uint8Array,
  ): Promise<string>;
  downloadFromHome(slug: string, rel: string): Promise<[Buffer, string, boolean]>;
  homeArchiveStream(slug: string): Promise<NodeJS.ReadableStream>;
  restoreHome(slug: string, tarPath: string, wipe?: boolean): Promise<void>;
}

// ------------------------------------------------------------------ errors
//
// Shared because the routes catch them to choose a status code, and a caller
// should not have to know which backend raised one.

/** The desktop image has no clipboard tooling and it could not be added. */
export class ClipboardUnavailable extends Error {}
/** Refuse to read or write outside the machine's home directory. */
export class PathOutsideHome extends Error {}
/** The path is inside the home directory but is not there. */
export class HomePathMissing extends Error {}
