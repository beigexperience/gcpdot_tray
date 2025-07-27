////////////////////////////////////////////////////////
//
//   @todo: command not found shouldn't crash systray
//   @todo: sanitization general and specific
//   @todo: communication between tray and web interface - realtime websockets? event passing
//   @todo: reorder should change elements while draging also without waiting to drop
//   @todo: investigate what happens when running under WSL
//   @todo: see if compile is broken on Raspi, Debian, Ubuntu, Arch
//   @todo: Mobile interface ?? Context menu on touch screen ?? Drag and drop on touch screen ??
//   @todo: configuration allowable hosts and ports
//   @todo: https not supported, investigate
//   @todo: investigate if it is possible to have a single binary with all the necessary files 
//              possible with temp file unpacking for icons, would need to turn exe/binary for icon to hex and write it, anti-vir might complain
//              cosmopolitan redbean?? How dould Deno work with that
//              for windows replace context menu lib with Powershell and load system dlls/ .net C# shit as FFI
//              Deno 2.0/jsr actually working node library go_systray ? 
//              Use cosmopolitan to install Deno, fetch script from github and fetch required dlls instead?
//   @todo: consider:
//                        Modify the go code myself???? 
//                        https://github.com/getlantern/systray/blob/master/systray_windows.go
// 
//   @todo: write types for the menu items in config.json, also make menu item generators
//   @todo: make it so callbacks are loadable from file??? possible pain in the ass
//   @todo: show state of checkboxable things on the web panel
//   @todo: have a config is checkboxable y/n on the panel
//   @todo: right click item -> context option to toggle from web panel
//
//   @todo: transparency in icons in context menu is currently broken
//   @todo: config web panel css/style
//
////////////////////////////////////////////////////////

import SysTray, { Menu, MenuItem } from "https://deno.land/x/systray/mod.ts";
import { open } from "https://deno.land/x/open@v0.0.5/index.ts";
import { Handlebars, HandlebarsConfig } from 'https://deno.land/x/handlebars/mod.ts';
import * as os from "node:os";
const VERSION = "0.1.6-20250628";

let GCP_DOT_COLOR_AS_JSON = "https://get-gcp-dot-color.deno.dev/?json=true";
const FUDGE_ICON_FACTOR = 1; // @todo: fix the dot's current color on backend ??? we're off by one somewhere
const debounce_tray_update_ms = 200;
const fourchanThreadApiPolling_ms = 2 * 60 *1000;
let userRequestedQuit = false;

const HANDLEBARS_CONFIG: HandlebarsConfig = {
  baseDir: 'views',
  extname: '.hbs',
  layoutsDir: 'layouts/',
  partialsDir: 'partials/',
  cachePartials: true,
  defaultLayout: 'main',
  helpers: {
    "json": (context: unknown) => JSON.stringify(context, null, 2),
    "eq": (a: unknown, b: unknown) => a === b,
  },
  compilerOptions: undefined,
};

const handlebars = new Handlebars(HANDLEBARS_CONFIG);

// Configuration constants
const CONFIG_FILE = "config.json";
 
const PROCESS_CHECK_INTERVAL = 1000 * 60 * 5; 
let PROCESS_CHECK_INTERVAL_HANDLE ;

let trayIconRefreshMinutes =  5;

const INITIAL_PORT = 8992;
const MAX_RETRIES = 10;
const HOST = "127.0.0.1";
let tray: SysTray | null = null;
let tray_updating = false;
let PORT = INITIAL_PORT;

const tray_context_menu_item_types = ["process_monitor_on_off","launch_cmd", "open_url", "interface_command", "separator","callback_with_cache","4chan_thread_filter",""];

// Menu item structure
interface MenuItemConfig {
  label: string;
  command: string;
  type:(typeof tray_context_menu_item_types)[number];
  index: number;
  tooltip?: string;
  checked?: boolean;
  enabled?: boolean;
  hidden?: boolean;
  icon?: string;
  cache_state?: any;

  process_config?: {
    executable: string;
    workingDir?: string;
    title?: string;
    pid?: number;
    arguments?: string[]; 
  };
}

interface MenuItemClickable extends MenuItem {
  click?: () => void;
  items?: MenuItemClickable[];
}

interface CustomMenu extends Menu {
  items: MenuItemClickable[];
}

// System menu items
const systemMenuItems: MenuItemConfig[] = [
  { label: "<SEPARATOR>", command: "", type: "separator", index: -1 },
  { label: "Configure", command: "Configure", type: "interface_command", index: -1 },
  { label: "<SEPARATOR>", command: "", type: "separator", index: -1 },
  { label: "Quit", command: "Quit", type: "interface_command", index: -1 },
];
 

const DEFAULT_MENU: MenuItemConfig[] = [
  { label: "Configure", command: "Configure", type: "interface_command", index: -1 },
  { label: "<SEPARATOR>", command: "", type: "separator", index: -1 },
  { label: "Quit", command: "Quit", type: "interface_command", index: -1 }
];


type DotColorRange = { id: string; color1: string; color2: string };
const DOT_COLOR_RANGES: DotColorRange[] = [
  {id: 'gcpdot0',  color1: '#CDCDCD', color2: '#505050'},
  {id: 'gcpdot1',  color1: '#FFA8C0', color2: '#FF0064'},
  {id: 'gcpdot2',  color1: '#FF1E1E', color2: '#840607'},
  {id: 'gcpdot3',  color1: '#FFB82E', color2: '#C95E00'},
  {id: 'gcpdot4',  color1: '#FFD517', color2: '#C69000'},
  {id: 'gcpdot5',  color1: '#FFFA40', color2: '#C6C300'},
  {id: 'gcpdot6',  color1: '#F9FA00', color2: '#B0CC00'},
  {id: 'gcpdot7',  color1: '#AEFA00', color2: '#88C200'},
  {id: 'gcpdot8',  color1: '#64FA64', color2: '#00A700'},
  {id: 'gcpdot9',  color1: '#64FAAB', color2: '#00B5C9'},
  {id: 'gcpdot10', color1: '#ACF2FF', color2: '#21BCF1'},
  {id: 'gcpdot11', color1: '#0EEEFF', color2: '#0786E1'},
  {id: 'gcpdot12', color1: '#24CBFD', color2: '#0000FF'},
  {id: 'gcpdot13', color1: '#5655CA', color2: '#2400A0'}
];

// DOT_COLOR_RANGES color names:
// gcpdot0:  #CDCDCD → #505050   // Light Gray → Dark Gray
// gcpdot1:  #FFA8C0 → #FF0064   // Light Pink → Hot Pink
// gcpdot2:  #FF1E1E → #840607   // Bright Red → Dark Red
// gcpdot3:  #FFB82E → #C95E00   // Orange     → Burnt Orange
// gcpdot4:  #FFD517 → #C69000   // Yellow     → Mustard
// gcpdot5:  #FFFA40 → #C6C300   // Pale Yellow→ Olive Yellow
// gcpdot6:  #F9FA00 → #B0CC00   // Neon Yellow→ Chartreuse
// gcpdot7:  #AEFA00 → #88C200   // Lime       → Olive Green
// gcpdot8:  #64FA64 → #00A700   // Green      → Dark Green
// gcpdot9:  #64FAAB → #00B5C9   // Aqua       → Teal
// gcpdot10: #ACF2FF → #21BCF1   // Light Blue → Sky Blue
// gcpdot11: #0EEEFF → #0786E1   // Cyan       → Blue
// gcpdot12: #24CBFD → #0000FF   // Blue       → Deep Blue
// gcpdot13: #5655CA → #2400A0   // Purple     → Dark Purple


// Utility to convert hex color to RGB array
function hexToRgb(hex: string): [number, number, number] {
  hex = hex.replace(/^#/, "");
  if (hex.length === 3) hex = hex.split("").map(x => x + x).join("");
  const num = parseInt(hex, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

// Calculate Euclidean distance between two RGB colors
function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt(
    Math.pow(a[0] - b[0], 2) +
    Math.pow(a[1] - b[1], 2) +
    Math.pow(a[2] - b[2], 2)
  );
}

// Find the closest color range index for the given RGB
function findClosestDotIndex(rgb: [number, number, number]): number {
  let minDist = Infinity;
  let minIdx = 0;
  for (let i = 0; i < DOT_COLOR_RANGES.length; i++) {
    const c1 = hexToRgb(DOT_COLOR_RANGES[i].color1);
    const c2 = hexToRgb(DOT_COLOR_RANGES[i].color2);
    
    const avg: [number, number, number] = [
      Math.round((c1[0] + c2[0]) / 2),
      Math.round((c1[1] + c2[1]) / 2),
      Math.round((c1[2] + c2[2]) / 2),
    ];
    const dist = colorDistance(rgb, avg);
    if (dist < minDist) {
      minDist = dist;
      minIdx = i;
    }
  }
  return minIdx;
}

let updateTrayPromise: Promise<void> = Promise.resolve();

let trayUpdateTimeout: number | undefined;

function queueUpdateTray(silent = false) {
  if (trayUpdateTimeout) {
    clearTimeout(trayUpdateTimeout);
  }
  trayUpdateTimeout = setTimeout(() => {
    updateTrayPromise = updateTrayPromise.then(() => updateTray(silent)).catch((e) => {
      console.warn("updateTray error (ignored):", e);
    });
    trayUpdateTimeout = undefined;
  }, debounce_tray_update_ms);
}

async function resolve_icon(icon?: string): Promise<string | undefined> {
  if (!icon) return undefined;
  if (icon.startsWith("http://") || icon.startsWith("https://")) {
    // Download to temp dir
    const ext = icon.endsWith(".ico") ? ".ico" : ".png";
    const tempDir = `${Deno.env.get("TEMP") || Deno.env.get("TMPDIR") || "/tmp"}/gcpdot_tray_icons`;
    try { await Deno.mkdir(tempDir, { recursive: true }); } catch {}
    // Use a hash of the URL as filename to avoid collisions
    const hash = Array.from(new TextEncoder().encode(icon)).reduce((a, b) => ((a << 5) - a) + b, 0);
    const tempPath = `${tempDir}/icon_${hash}${ext}`;
    // Download only if not already present
    if (!(await file_exists(tempPath))) {
      const resp = await fetch(icon);
      if (!resp.ok) throw new Error(`Failed to download icon: ${icon}`);
      const data = new Uint8Array(await resp.arrayBuffer());
      await Deno.writeFile(tempPath, data);
    }
    return tempPath;
  }
  // Local file, just return as is
  return icon;
}

// Fetch the color and decide which icon to use
async function getDynamicTrayIcon(): Promise<string> {
  try {
    const { os } = Deno.build;
    const ext = os === "windows" ? "ico" : "png";
    let idx:number;
     if (dotColorSource === "processor") {      
      const map_cpu_to = 13;
      const cpuUtil =  get_cpu_utilization(); // float 0.0 to 1.0
      if (cpuUtil >= 0.95) {
        idx = 1;
      } else if (cpuUtil == 0) {
        idx=0;
      }  else {
        // Map 0.0 (idle) to 13, 0.95 (just below 95%) to 1
        idx = Math.max(1, Math.min(13, 13 - Math.round(cpuUtil / 0.95 * 12) + 1));
      }
      // idx = Math.max(1, Math.min(map_cpu_to, idx));
      return `./icons/dot${idx}.${ext}`;
    } else if (dotColorSource === "ram") {
      const ram_clamp_min_idx =  1;
      const ram_clamp_max_idx = 10;
      const ram_scale_skew = 1; // 0.95 utilization maps to max index
      const ramUtil = await get_ram_utilization(); // float 0.0 to 1.0
      console.log("RAM Utilization:", ramUtil);
      if (ramUtil >= 0.90) {
        idx = 1;
      } else if (ramUtil == 0) {
        idx = 0;
      } else {
        
       
        idx = Math.max(ram_clamp_min_idx, Math.min(ram_clamp_max_idx, ram_clamp_max_idx - Math.round(ramUtil / ram_scale_skew * (ram_clamp_max_idx - ram_clamp_min_idx)) + 1));
      }
      console.log(idx);
      // console.warn("RAM color source is not implemented yet");
      // idx=0;
      return `./icons/dot${idx}.${ext}`;
    }

    // Default: gcpdot
    const res = await fetch(GCP_DOT_COLOR_AS_JSON);
    const data = await res.json();
    const rgb: [number, number, number] = data.crgb;
    idx = findClosestDotIndex(rgb);        
    idx = Math.max(0, Math.min(13, idx + FUDGE_ICON_FACTOR));
    return `./icons/dot${idx}.${ext}`;
  } catch (e) {
    console.error("Failed to fetch dynamic tray icon, using dot0.", e);
    const { os } = Deno.build;
    const ext = os === "windows" ? "ico" : "png";
    return `./icons/dot0.${ext}`;
  }
}

// Get the appropriate icon based on OS
// async function getIconUrl() {
//   const { os } = Deno.build;
//   const iconUrl =
//     "https://raw.githubusercontent.com/wobsoriano/deno-systray/master/example";

//   let iconName;
//   switch (os) {
//     case "windows":
//       iconName = `${iconUrl}/icon.ico`;
//       break;
//     case "linux":
//       iconName = `${iconUrl}/icon.png`;
//       break;
//     case "darwin":
//       throw new Error("macOS is not supported.");
//     default:
//       throw new Error(`Unsupported operating system: ${os}`);
//   }

//   const icon = "icon.ico";
//   return icon;
// }

// Load menu items from config file if it exists
async function loadConfig() {
  try {
    const configText = await Deno.readTextFile(CONFIG_FILE);
    const loadedConfig: AppConfig = JSON.parse(configText);

    dotColorSource = loadedConfig.dotColorSource ?? "gcpdot";
    trayIconRefreshMinutes = Math.max(0.1, Math.min(120, loadedConfig.trayIconRefreshMinutes ?? 5)); 

    userMenuItems = loadedConfig.menu.filter((item: MenuItemConfig) => {
      const hasValidIcon = isValidIcon(item.icon);
      if (!hasValidIcon) {
        console.error(`Invalid icon format for menu item "${item.label}". Must be .ico, .png or @EXTRACT@`);
        item.icon = undefined;
      }
      return item.label &&
        (item.command || item.type === "separator") &&
        tray_context_menu_item_types.includes(item.type);
    });

    console.log("Loaded config.json:", { dotColorSource, userMenuItems });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.log("No config file found, using default config.");
      await saveConfig();
    } else {
      console.error("Error loading config:", error);
    }
  }
}

// Attempt to write config.json in current directory, fallback to OS-specific config dir
async function saveConfig(config?: any) {
  const configData = JSON.stringify(config ?? {
    dotColorSource,
    trayIconRefreshMinutes,
    menu: userMenuItems
  }, null, 2);

  let configPath = "config.json";
  try {
    await Deno.writeTextFile(configPath, configData);
    return configPath;
  } catch (err) {
    // Fallback logic
    let fallbackDir: string;
    if (Deno.build.os === "windows") {
      fallbackDir = Deno.env.get("APPDATA")
        ? `${Deno.env.get("APPDATA")}/gcpdot_tray`
        : `${Deno.env.get("USERPROFILE")}/AppData/Roaming/gcpdot_tray`;
    } else {
      const xdg = Deno.env.get("XDG_CONFIG_HOME");
      fallbackDir = xdg
        ? `${xdg}/gcpdot_tray`
        : `${Deno.env.get("HOME")}/.config/gcpdot_tray`;
    }
    try {
      await Deno.mkdir(fallbackDir, { recursive: true });
    } catch (_) { /* ignore if exists */ }
    configPath = `${fallbackDir}/config.json`;
    await Deno.writeTextFile(configPath, configData);
    return configPath;
  }
}

async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    const command = new Deno.Command("powershell", {
      args: ["-Command", `Get-Process -Id ${pid} -ErrorAction SilentlyContinue`],
    });
    const { code } = await command.output();
    return code === 0;
  } catch {
    return false;
  }
}

async function findProcessByName(exeName: string): Promise<number[]> {
  try {
    exeName = exeName.replace(/\.(exe|com)$/, ""); // Remove .exe or .com extension
    
    const command = new Deno.Command("powershell", {
      args: ["-Command", `(Get-Process "${exeName}" -ErrorAction SilentlyContinue).Id`],
    });
    const { stdout } = await command.output();
    const output = new TextDecoder().decode(stdout).trim();
    // console.log("fp_n_204", output);
    
    
    if (!output) return [];
    return output.split('\n').map(pid => parseInt(pid.trim())).filter(pid => !isNaN(pid));
  } catch {
    return [];
  }
}
async function killProcess(pid: number): Promise<boolean> {
  try {
    const command = new Deno.Command("powershell", {
      args: ["-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`],
    });
    const { code } = await command.output();
    return code === 0;
  } catch {
    return false;
  }
}


async function updateProcessStatus(item: MenuItemConfig, exeName: string) {
  const newPids = await findProcessByName(exeName);
  const wasChecked = item.checked;
  
  item.checked = newPids.length > 0;
  item.cache_state = { ...item.cache_state, pids: newPids };
  
  
  if (wasChecked !== item.checked) {
    await saveConfig();
    // await updateTray();
    // queueUpdateTray();
  }
  
  return newPids;
}


async function file_exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
 
const operationQueue: Promise<void>[] = [];
let isProcessingQueue = false;

async function processOperationQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (operationQueue.length > 0) {
    const operation = operationQueue.shift();
    if (operation) {
      try {
        await operation;
      } catch (error) {
        console.error("Operation failed:", error);
      }
    }
  }

  isProcessingQueue = false;
}

// Add this function to queue operations
function queueOperation(operation: Promise<void>) {
  operationQueue.push(operation);
  processOperationQueue();
}

async function parseCommandAndArgs(commandString: string): Promise<{ command: string; args: string[] }> {
  // Split by spaces, but keep quoted substrings together
  const parts = commandString.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  // Try to find the longest prefix that is a valid file
  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join(" ").replace(/^"(.+)"$/, "$1");
    if (await file_exists(candidate)) {
      return {
        command: candidate,
        args: parts.slice(i)
      };
    }
  }
  // Fallback: treat first part as command, rest as args
  const cleaned = parts.map(part => part.replace(/^"(.+)"$/, '$1'));
  return {
    command: cleaned[0],
    args: cleaned.slice(1)
  };
}


async function click_handler(item: any, type: MenuItemConfig['type'], command: MenuItemConfig['command']) {
  if (type === "separator") return;

  const operation = async () => {
    switch (type) {
      case "4chan_thread_filter": {
        // command format: "{board name}|{part of the title}"
        let [board, ...filterParts] = (command || "").split("|");
        board = (board || "pol").trim();
        const filter = filterParts.join("|").trim().toLowerCase();
        if (!board || !filter) {
          console.error("4chan_thread_filter: Invalid command format. Use {board}|{filter}");
          return;
        }
        try {
          const url = `https://a.4cdn.org/${board}/catalog.json`;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const pages = await res.json();
          const matches: { no: number; sub: string; url: string }[] = [];
          for (const page of pages) {
            for (const thread of page.threads) {
              if (thread.sub && thread.sub.toLowerCase().includes(filter)) {
                matches.push({
                  no: thread.no,
                  sub: thread.sub,
                  url: `https://boards.4chan.org/${board}/thread/${thread.no}`
                });
              }
            }
          }
          if (matches.length > 0) {
            // Restore label if it had "- no bread"
            const originalLabel = item.label.replace(/\s*- no bread$/, "");
            if (originalLabel !== item.label) {
              item.label = originalLabel;
              await saveConfig();
              queueUpdateTray();
            }
            await openURL(matches[0].url);
          } else {
            // Append "- no bread" if not already present
            if (!item.label.endsWith(" - no bread")) {
              item.label = `${item.label} - no bread`;
              await saveConfig();
              queueUpdateTray();
            }
            // Open the board page if no bread
            await openURL(`https://boards.4chan.org/${board}/`);
            console.log(`No matching threads found for filter: "${filter}" on /${board}/`);
          }
        } catch (e) {
          console.error("Error fetching 4chan catalog:", e);
        }
        break;
      }

      case "process_monitor_on_off": {
        const procConfig = item.process_config;
        if (!procConfig) return;
      
        const exeName = procConfig.executable.split("\\").pop() || procConfig.executable;
        const pids = await findProcessByName(exeName);
      
        if (pids.length > 0) {
          // Kill all instances sequentially
          for (const pid of pids) {
            const killed = await killProcess(pid);
            if (!killed) {
              console.error(`Failed to kill process with PID ${pid}`);
            }
          }
        } else {
          // Start process with arguments
          try {
            const command = new Deno.Command(procConfig.executable, {
              cwd: procConfig.workingDir,
              args: procConfig.arguments || [], // Add arguments support
            });
            const process = command.spawn();
          } catch (error) {
            console.error(`Failed to start process: ${error}`);
          }
        }

        // Wait before updating status
        await new Promise(resolve => setTimeout(resolve, 4000));
        await updateProcessStatus(item, exeName);
        break;
      }

      case "launch_cmd":
      await new Promise<void>((resolve, reject) => {
        // Move async logic to an inner function
        (async () => {
          let exePath = command;
          let args: string[] = [];
          // If the command is quoted, remove quotes
          if ((exePath.startsWith('"') && exePath.endsWith('"')) || (exePath.startsWith("'") && exePath.endsWith("'"))) {
            exePath = exePath.slice(1, -1);
          }
          // Use improved parseCommandAndArgs
          const parsed = await parseCommandAndArgs(command);
          exePath = parsed.command;
          args = parsed.args;
          let cmd: Deno.Command;
          if (Deno.build.os === "windows" && exePath.toLowerCase().endsWith(".lnk")) {
            cmd = new Deno.Command("powershell", {
              args: [
                "-NoProfile",
                "-Command",
                `Start-Process -FilePath "${exePath}"`
              ]
            });
          } else {
            cmd = new Deno.Command(exePath, { args });
          }
          try {
            const { code, stdout, stderr } = await cmd.output();
            if (code === 0) {
              console.log(new TextDecoder().decode(stdout));
            } else {
              console.error(new TextDecoder().decode(stderr));
            }
            resolve();
          } catch (err) {
            console.error(`Error launching ${command}:`, err);
            reject(err);
          }
        })();
      });
      break;

      case "open_url":
        await openURL(command);
        break;

      case "callback_with_cache": {
        const this_index = item.index;
        console.log("Callback with cache");
        const callback = eval(command);
        const cache_state = item?.cache_state ?? {};
        const new_cache_state = await callback(item, cache_state, userMenuItems, callback_func_external);
        
        userMenuItems = userMenuItems.map((_item) => {
          if (this_index === _item.index) {
            _item.cache_state = cache_state;
          }
          return _item;
        });

        if (new_cache_state?.reload_menu) {
          new_cache_state.reload_menu = false;
          await callback_func_external.saveConfig();
        } else {
          await callback_func_external.saveConfig();
        }
        break;
      }

      case "interface_command":
        switch (command) {
          case "Quit":
            userRequestedQuit = true;
            if (tray) { await tray.kill(); }
            Deno.exit();
            break;
          case "Configure":
            await openURL(`http://${HOST}:${PORT}/`);
            break;
        }
        break;
    }
  };

  queueOperation(operation());
}

function isValidIcon(icon: string | undefined): boolean {
  if (!icon) return true; // undefined/null is valid
  return icon.toLowerCase().endsWith('.ico') || icon.toLowerCase().endsWith('.png');
}

let trayKilling = false;


// Create or update the tray icon
async function updateTray(silent=false) {
  tray_updating = true;
  const icon = await getDynamicTrayIcon();

  // If tray exists, kill it and wait for exit before creating a new one
  if (tray && !trayKilling) {
    trayKilling = true;
    try {
      const exitPromise = new Promise<void>((resolve) => {
        const onExit = () => {
          tray?.off("exit", onExit);
          resolve();
        };
        tray?.on("exit", onExit);
      });
      await tray.kill(!tray_updating);
      await exitPromise;
    } catch (e) {
      console.warn("Tray kill error (ignored):", e);
    }
    trayKilling = false;
  }

   // Now create the new tray
  const menu: CustomMenu = {
    icon,
    isTemplateIcon: false,
    title: "Tray app title",
    tooltip: "Tray app tooltip",
    items: await Promise.all(
      [...userMenuItems, ...systemMenuItems].map(async (item) => ({
        title: item.label,
        tooltip: item?.tooltip ?? item.label,
        checked: item?.checked ?? false,
        enabled: item?.enabled ?? true,
        hidden: item?.hidden ?? false,
        icon: await resolve_icon(item.icon), 
        click: () => click_handler(item, item.type, item.command),
      }))
    ),
  };

  tray = new SysTray({
    menu,
    debug: true,
    directory: "bin",
  });

  tray.on("click", (action) => {
    if ((action.item as MenuItemClickable).click) {
      (action.item as MenuItemClickable).click!();
    } else if (action.seq_id === -1) {
      openURL(`http://${HOST}:${PORT}/`);
    }
  });

  tray.on("exit", () => {
    if (!silent){
      console.log(`Tray exited${tray_updating ? " (updating)" : ""}`);
    }
    if (userRequestedQuit && !tray_updating) {
      Deno.exit();
    }
    tray_updating = false;
  });

  tray.on("error", (err) => {
    console.error("Tray error:", err);
  });

  await tray.ready();
  if (!silent) {   
    console.log(`Tray is ready${tray_updating ? " (updating)" : ""}`);
  }
}

async function updateProcessStatuses() {
  let needsUpdate = false;

  for (const item of userMenuItems) {
    if (item.type === "process_monitor_on_off" && item.process_config) {
      const exeName = item.process_config.executable.split("\\").pop() || item.process_config.executable;
      const pids = await findProcessByName(exeName);
      
      const wasChecked = item.checked;
      item.checked = pids.length > 0;
      
      if (wasChecked !== item.checked) {
        item.cache_state = { ...item.cache_state, pids: pids };
        needsUpdate = true;
      }
    }
  }

  if (needsUpdate) {
    await saveConfig();
      queueUpdateTray(true); 
  }
}

// Open a URL in the default browser
function openURL(url: string) {
  open(url).catch((err) => console.error("Error opening URL:", err));
}

// Launch a command specified in the menu
async function launchCommand(cmd: string): Promise<void> {
  try {
    const { command, args } = await parseCommandAndArgs(cmd); // <-- add await
    const process = new Deno.Command(command, { args });
    const { code, stdout, stderr } = await process.output();
    if (code === 0) {
      console.log(new TextDecoder().decode(stdout));
    } else {
      console.error(new TextDecoder().decode(stderr));
    }
  } catch (err) {
    console.error(`Error launching ${cmd}:`, err);
  }
}

const callback_func_external = {
  updateTray: updateTray,
  openURL: openURL, 
  launchCommand: launchCommand,
  saveConfig: saveConfig,
  loadConfig: loadConfig,
}


const index_html_content_hndlbars = await handlebars.renderView("index", { name: "Alosaur" });

// ram utilization functions

async function get_ram_utilization(): Promise<number> {
  try {
    const usedMem = os.totalmem() - os.freemem();
    const totalMem = os.totalmem();
    return totalMem > 0 ? usedMem / totalMem : 0;
  } catch (e) {
    console.warn("get_ram_utilization failed, returning 1:", e);
    return 1;
  }
}

// /ram utilization functions

// cpu utilization functions
type cpu_util_CpuTimes = {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
};

function cpu_util_cpuSnapshot(): cpu_util_CpuTimes[] {
  try {    
    const times = os.cpus().map(cpu => cpu.times);    
    return times;
  } catch (e) {
    // If os.cpus() fails, return a single CPU with all zero values
    console.warn("cpu_util_cpuSnapshot failed, returning zeros:", e);
    return [{
      user: 0,
      nice: 0,
      sys: 0,
      idle: 0,
      irq: 0,
    }];
  }
}

function cpu_util_calculateCpuUsage(prev: cpu_util_CpuTimes[], curr: cpu_util_CpuTimes[]): number[] {
  return curr.map((c, i) => {
    const p = prev[i];
    const idleDelta = c.idle - p.idle;
    const totalDelta =
      (c.user + c.nice + c.sys + c.idle + c.irq) -
      (p.user + p.nice + p.sys + p.idle + p.irq);
    return totalDelta > 0 ? 1 - idleDelta / totalDelta : 0;
  });
}



let prevcpu_util_cpuSnapshot = cpu_util_cpuSnapshot();

function get_cpu_utilization():  number {
  const curr = cpu_util_cpuSnapshot();
  const usages = cpu_util_calculateCpuUsage(prevcpu_util_cpuSnapshot, curr);
  prevcpu_util_cpuSnapshot = curr;
  // Return average utilization (0.0 to 1.0)
  return usages.reduce((sum, u) => sum + u, 0) / usages.length;
}



// /cpu utilization functions

//  interface for the config file
interface AppConfig {
  dotColorSource: "gcpdot" | "processor" | "ram";
  menu: MenuItemConfig[];
  trayIconRefreshMinutes?: number;
}


const DEFAULT_CONFIG: AppConfig = {
  dotColorSource: "gcpdot",
  trayIconRefreshMinutes: 5,
  menu: [    
    {
      "label": "/skg/",
      "command": "pol|/skg/",
      "type": "4chan_thread_filter",
      "icon": "",
      "checked": false,
      "index": 1
    },
    {
      "label": "The dot",
      "command": "https://global-mind.org/gcpdot/",
      "type": "open_url",
      "icon": "",
      "checked": false,
      "index": 2
    },
    {
      "label": "Ponder",
      "command": "https://beigexperience.github.io/ponderthedot/",
      "type": "open_url",
      "icon": "",
      "checked": false,
      "index": 3
    }
  ]
};


let dotColorSource: AppConfig["dotColorSource"] = DEFAULT_CONFIG.dotColorSource;
let userMenuItems: MenuItemConfig[] = [...DEFAULT_CONFIG.menu];



const HTML_CONTENT_CONFIGURE = await handlebars.renderView("configure", {
  tray_context_menu_item_types: tray_context_menu_item_types,
  dotColorSource,
  trayIconRefreshMinutes
});



// HTTP request handler
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png") {
    // Get the current dot icon path
    const iconPath = await getDynamicTrayIcon();
    try {
      const iconData = await Deno.readFile(iconPath);
      const contentType = iconPath.endsWith(".ico") ? "image/x-icon" : "image/png";
      return new Response(iconData, { headers: { "Content-Type": contentType } });
    } catch (e) {
      return new Response("Not Found", { status: 404 });
    }
  }
  if (url.pathname === "/") {
    return new Response(HTML_CONTENT_CONFIGURE, { headers: { "Content-Type": "text/html" } });
  } else if (url.pathname === "/get-menu") {
    return new Response(JSON.stringify({
      dotColorSource,
      trayIconRefreshMinutes,
      menu: userMenuItems
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } else if (url.pathname === "/update-menu" && req.method === "POST") {
    tray_updating = true;
    try {
      const body = await req.json();
      
      if (body.dotColorSource) {
        dotColorSource = body.dotColorSource;
      }

      if (body.trayIconRefreshMinutes !== undefined) {
        trayIconRefreshMinutes = Math.max(0.1, Math.min(120, Number(body.trayIconRefreshMinutes)));
        restartTrayIconRefreshInterval();
      }

      userMenuItems = (body.menu ?? body).filter(async (item: MenuItemConfig) => {
        
        if (item.type === "separator") return true;
        if (!item.label || !item.command) return false;
        
        
        if (item.process_config) {
          
          if (item.process_config.arguments) {
          
            if (typeof item.process_config.arguments === "string") {
              const argString = (typeof item.process_config.arguments === 'string' ? item.process_config.arguments : '').trim();
              if (argString.length > 0) {
                const parsed = await parseCommandAndArgs(argString); // <-- add await
                item.process_config.arguments = parsed.args;
                if (!item.process_config.arguments || item.process_config.arguments.length === 0) {
                  item.process_config.arguments = [argString];
                }
              } else {
                item.process_config.arguments = [];
              }
            }
          } else {
            item.process_config.arguments = [];
          }

          if (!item.process_config.executable) {
            delete item.process_config;
          }
        }
        
        return true;
      });
      await saveConfig();
      // await updateTray();
      queueUpdateTray();
      return new Response("Menu updated", { status: 200 });
    } catch (error) {
      return new Response("Error updating menu", { status: 500 });
    }
  }
  return new Response("Not Found", { status: 404 });
}

// Find an available port
  function findAvailablePort(startPort: number, maxRetries: number): number {
  for (let port = startPort; port < startPort + maxRetries; port++) {
    try {
      const listener = Deno.listen({ port, hostname: HOST });
      listener.close();
      return port;
    } catch (error) {
      if (error instanceof Deno.errors.AddrInUse) {
        console.log(`Port ${port} is in use, trying next...`);
      } else {
        throw error;
      }
    }
  }
  throw new Error(`No available port found after ${maxRetries} retries.`);
}


  function start4chanThreadFilterPolling() {
  async function checkAndUpdateAll() {
    let updated = false;
    for (const item of userMenuItems) {
      if (item.type === "4chan_thread_filter") {
        let [board, ...filterParts] = (item.command || "").split("|");
        board = (board || "pol").trim();
        const filter = filterParts.join("|").trim().toLowerCase();
        if (!board || !filter) continue;

        try {
          const url = `https://a.4cdn.org/${board}/catalog.json`;
          const res = await fetch(url);
          if (!res.ok) continue;
          const pages = await res.json();
          let found = false;
          for (const page of pages) {
            for (const thread of page.threads) {
              if (thread.sub && thread.sub.toLowerCase().includes(filter)) {
                found = true;
                break;
              }
            }
            if (found) break;
          }
          // Update label if needed
          const originalLabel = item.label.replace(/\s*- no bread$/, "");
          if (found && item.label.endsWith(" - no bread")) {
            item.label = originalLabel;
            updated = true;
          } else if (!found && !item.label.endsWith(" - no bread")) {
            item.label = `${originalLabel} - no bread`;
            updated = true;
          }
        } catch (e) {
          // Ignore fetch errors for polling
        }
      }
    }
    if (updated) {
      await saveConfig();
        queueUpdateTray(true);

    }
  }

  setInterval(checkAndUpdateAll,fourchanThreadApiPolling_ms); // every 2 minutes
  
  checkAndUpdateAll();
}

let trayIconRefreshIntervalHandle: number | undefined;
function restartTrayIconRefreshInterval() {
  if (trayIconRefreshIntervalHandle) clearInterval(trayIconRefreshIntervalHandle);
  trayIconRefreshIntervalHandle = setInterval(() => queueUpdateTray(true), trayIconRefreshMinutes * 60 * 1000);

}

async function start() {
  const { os } = Deno.build;
  if (os === "darwin") {
    throw new Error("macOS is not supported.");
  }

  await loadConfig();



  
  PORT =   findAvailablePort(INITIAL_PORT, MAX_RETRIES);





  start4chanThreadFilterPolling();

  // Start the tray
  // await updateTray();
  queueUpdateTray();

  await updateProcessStatuses();

  
  PROCESS_CHECK_INTERVAL_HANDLE = setInterval(updateProcessStatuses, PROCESS_CHECK_INTERVAL);

  
  

  // Start the web server
  Deno.serve({ port: PORT, hostname: HOST }, handler);
  console.log(`Server running at http://${HOST}:${PORT}/`);

  restartTrayIconRefreshInterval();

}

start().catch(console.error);
