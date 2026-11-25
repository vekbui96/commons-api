/**
 * Windows runtime pieces for the identity checks, ported from the hub's action
 * server (D:\hub\action-server\server.mjs): who owns this node, its tailnet IPs,
 * and whether a TCP peer is the Tailscale service. Production only; tests inject
 * their own values into SecurityConfig.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Socket } from "node:net";
import type { PeerCheck } from "./security";

const TAILSCALE = "C:\\Program Files\\Tailscale\\tailscale.exe";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const NETSTAT = "C:\\Windows\\System32\\netstat.exe";

function run(file: string, args: string[], timeout = 20000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout ?? "") });
    });
  });
}

export interface TailscaleIdentity {
  ownerLogin: string;
  selfIps: string[];
}

interface StatusJson {
  Self?: { UserID?: number; TailscaleIPs?: string[]; Tags?: string[] };
  User?: Record<string, { LoginName?: string }>;
}

/** Parses `tailscale status --json`: the login that owns this node and its tailnet IPs. */
export function parseStatus(text: string): TailscaleIdentity | null {
  let status: StatusJson;
  try {
    status = JSON.parse(text) as StatusJson;
  } catch {
    return null;
  }
  const self = status.Self ?? {};
  if (Array.isArray(self.Tags) && self.Tags.length) return null; // a tagged node has no owner login
  const login = status.User?.[String(self.UserID)]?.LoginName;
  if (!login) return null;
  return { ownerLogin: login, selfIps: self.TailscaleIPs ?? [] };
}

export async function readTailscaleIdentity(): Promise<TailscaleIdentity | null> {
  const r = await run(TAILSCALE, ["status", "--json"]);
  return r.code === 0 ? parseStatus(r.stdout) : null;
}

/** The last identity read, kept next to the database (never in the repo). */
export function readIdentityCache(file: string): TailscaleIdentity | null {
  try {
    const c = JSON.parse(readFileSync(file, "utf8")) as Partial<TailscaleIdentity>;
    return c.ownerLogin ? { ownerLogin: c.ownerLogin, selfIps: c.selfIps ?? [] } : null;
  } catch {
    return null;
  }
}

export function writeIdentityCache(file: string, id: TailscaleIdentity): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const note = "written by commons-api at start from tailscale status --json; fallback only";
    writeFileSync(file, JSON.stringify({ ...id, loadedAt: new Date().toISOString(), note }, null, 2));
  } catch {
    // informational cache only
  }
}

/**
 * Trusted peers: the Tailscale service process and its direct children
 * (tailscaled's /subproc does the proxying). A local process that dials
 * 127.0.0.1 with a forged identity header fails this check.
 */
export function makePeerCheck(localPort: number, log: (msg: string) => void = () => {}): PeerCheck {
  let trusted = new Set<number>();
  let loadedAt = 0;
  const verdicts = new WeakMap<Socket, Promise<{ ok: boolean; why?: string }>>();

  async function loadTrusted() {
    const cmd =
      "$s=(Get-CimInstance Win32_Service -Filter \"Name='Tailscale'\").ProcessId; if($s){$c=@(Get-CimInstance Win32_Process -Filter \"ParentProcessId=$s\" | ForEach-Object ProcessId); (@($s)+$c) -join ','}";
    const r = await run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", cmd]);
    const ids = r.stdout
      .trim()
      .split(",")
      .map((x) => parseInt(x, 10))
      .filter((x) => x > 0);
    if (ids.length) {
      trusted = new Set(ids);
      loadedAt = Date.now();
      log(`trusted tailscale pids: ${ids.join(",")}`);
    } else {
      log("could not read the Tailscale service pid");
    }
  }

  async function peerPid(socket: Socket): Promise<number | null> {
    const r = await run(NETSTAT, ["-ano", "-p", "TCP"], 15000);
    const rx = new RegExp(
      `^\\s*TCP\\s+127\\.0\\.0\\.1:${socket.remotePort}\\s+127\\.0\\.0\\.1:${localPort}\\s+\\S+\\s+(\\d+)\\s*$`,
      "m",
    );
    const m = rx.exec(r.stdout);
    return m ? parseInt(m[1]!, 10) : null;
  }

  return (socket) => {
    let verdict = verdicts.get(socket);
    if (!verdict) {
      verdict = (async () => {
        const addr = String(socket.remoteAddress ?? "");
        if (addr !== "127.0.0.1" && addr !== "::ffff:127.0.0.1") return { ok: false, why: "not loopback" };
        const pid = await peerPid(socket);
        if (!pid) return { ok: false, why: "peer process not found" };
        if (!trusted.has(pid) && Date.now() - loadedAt > 30000) await loadTrusted();
        return trusted.has(pid) ? { ok: true } : { ok: false, why: `peer pid ${pid} is not tailscaled` };
      })();
      verdicts.set(socket, verdict);
    }
    return verdict;
  };
}
