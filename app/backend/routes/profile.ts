// app/backend/routes/profile.ts
import { spawn as spawnChild, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Express } from "express";
import type { Session } from "../session.js";
import * as frida from "frida";
import { detectBuildId } from "../core/detect.js";
import { SerializerConfigStore } from "../core/network/serializer-config.js";
import { DiskPluginStorage } from "../core/plugin-storage.js";

const execFileAsync = promisify(execFile);

/** PowerShell watcher: poll process list, NtSuspendProcess on first match,
 *  print "pid\tpath" to stdout. Returns the info, or null on timeout. */
async function watchAndSuspendProcess(
    pattern: string,
    timeoutMs: number,
    pollIntervalMs = 50,
): Promise<{ pid: number; exePath: string } | null> {
    // Sanitize pattern — only allow alphanumeric, dash, dot, underscore.
    // PowerShell wildcard injection avoidance.
    const safe = pattern.replace(/[^A-Za-z0-9._-]/g, "");
    if (!safe) return null;
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("ntdll.dll")] public static extern uint NtSuspendProcess(IntPtr h);'
$deadline = (Get-Date).AddMilliseconds(${timeoutMs})
while ((Get-Date) -lt $deadline) {
    $proc = Get-Process | Where-Object { $_.Name -like '*${safe}*' } | Select-Object -First 1
    if ($proc) {
        [W.K]::NtSuspendProcess($proc.Handle) | Out-Null
        # Path can be unreliable on a freshly-spawned process; try multiple sources.
        $exePath = $proc.Path
        if (-not $exePath) {
            try { $exePath = $proc.MainModule.FileName } catch {}
        }
        if (-not $exePath) {
            try {
                $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)" -ErrorAction SilentlyContinue
                if ($cim) { $exePath = $cim.ExecutablePath }
            } catch {}
        }
        Write-Output ("{0}\`t{1}" -f $proc.Id, $exePath)
        exit 0
    }
    Start-Sleep -Milliseconds ${pollIntervalMs}
}
exit 1
`;
    return new Promise((resolve) => {
        const child = spawnChild("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
        let stdout = "";
        child.stdout.on("data", (d) => { stdout += d.toString(); });
        child.on("error", () => resolve(null));
        child.on("close", (code) => {
            if (code !== 0) return resolve(null);
            const line = stdout.trim();
            const [pidStr, ...rest] = line.split("\t");
            const exePath = rest.join("\t");
            const n = parseInt(pidStr, 10);
            if (!Number.isFinite(n)) return resolve(null);
            resolve({ pid: n, exePath });
        });
    });
}

/** NtResumeProcess on the given pid (best effort, no throw). */
async function resumeProcess(pid: number): Promise<void> {
    const script = `
Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("ntdll.dll")] public static extern uint NtResumeProcess(IntPtr h);'
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($p) { [W.K]::NtResumeProcess($p.Handle) | Out-Null }
`;
    try { await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]); }
    catch { /* best-effort */ }
}

export interface ProfileDeps {
    session: Session;
}

function serializeProfile(p: ReturnType<Session["profile"]>) {
    if (!p) return null;
    return {
        manifest: p.manifest,
        rootPath: p.rootPath,
    };
}

export function mountProfile(app: Express, deps: ProfileDeps): void {
    app.get("/api/profile", (_req, res) => {
        res.json({ profile: serializeProfile(deps.session.profile()) });
    });

    app.get("/api/profile/processes", async (_req, res) => {
        try {
            const processes = await deps.session.fridaClient.listProcesses();
            res.json({ processes });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        }
    });

    app.post("/api/profile/attach", async (req, res) => {
        const { pid } = req.body ?? {};
        if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
            res.status(400).json({ error: "pid (positive integer) required" });
            return;
        }
        try {
            const profile = await deps.session.attach(pid);
            res.json({ profile: serializeProfile(profile) });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        }
    });

    // Spawn an executable suspended, load the agent, pre-queue the network
    // capture arm (it'll fire AFTER IL2CPP initializes), then resume.
    //
    // Order of operations matters: agent-ready can only fire once IL2CPP is
    // up — which requires the process to be resumed. But we want the network
    // hook armed BEFORE the game's first WS frame. Frida's perform queue is
    // FIFO: we queue the arm RPC while suspended; it sits in the queue
    // alongside index.ts's "send agent-ready" callback. On resume, IL2CPP
    // initializes, both queued performs fire in order, hook is installed,
    // game's later WS connect is captured.
    app.post("/api/profile/spawn", async (req, res) => {
        const { exePath } = req.body ?? {};
        if (typeof exePath !== "string" || !exePath) {
            res.status(400).json({ error: "exePath (string) required" });
            return;
        }
        const fc = deps.session.fridaClient;
        let pid: number | null = null;
        try {
            pid = await fc.spawn(exePath);

            // Load the agent script into the suspended process. agent-ready
            // can't fire yet (IL2CPP not up), so don't wait for it here.
            await fc.attach(pid, { suspended: true });

            // Pre-queue the network arm RPC. The promise won't resolve until
            // after resume + IL2CPP init, but the request is "in flight" so
            // it'll be processed as soon as IL2CPP fires perform callbacks.
            const cfgStore = deps.session.serializerConfigStore();
            const config = cfgStore?.get();
            const hasEnabled = !!config && config.entries.some((e) => !e.disabled);
            const armP = hasEnabled
                ? fc.call("armNetworkCapture", [config]).catch((e) => {
                    console.warn("[spawn] armNetworkCapture failed:", e);
                })
                : Promise.resolve();

            // Resume — game starts running, IL2CPP boots, queued performs fire.
            await fc.resume(pid);

            // Now wait for agent-ready (fires from index.ts's perform), then
            // for the arm RPC to complete (its perform fires next). 30s budget
            // is generous — typical Dofus boot to IL2CPP-ready is ~5-10s.
            await Promise.race([
                fc.waitForAgentReady(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("agent-ready timeout (30s)")), 30_000)),
            ]);
            await armP;

            // Run the rest of session.attach — fingerprints, label migration,
            // profile setup, etc. The fridaClient is already attached so we
            // skip the re-attach inside _doAttach.
            const profile = await deps.session.attach(pid, { skipFridaAttach: true });

            res.json({ pid, profile: serializeProfile(profile), netCaptureArmed: hasEnabled });
        } catch (err) {
            // Best-effort cleanup: if we got a pid but never finished, kill it.
            if (pid !== null) {
                try { await fc.detach(); } catch {}
            }
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        }
    });

    // Poll the process list and attach as soon as a matching process appears.
    // For games like Dofus that require launching via a third-party tool
    // (Ankama Launcher) for auth — we can't spawn the game ourselves, but we
    // CAN attach within a few hundred ms of it appearing, well before its
    // C# networking code initializes.
    //
    // Body: { processNamePattern: string, timeoutMs?: number }
    //   processNamePattern matches the process name with a case-insensitive
    //   substring (e.g. "dofus" matches "Dofus.exe"). Returns immediately
    //   if the process is already running.
    app.post("/api/profile/watch-and-attach", async (req, res) => {
        const pattern = String(req.body?.processNamePattern ?? "").toLowerCase();
        if (!pattern) {
            res.status(400).json({ error: "processNamePattern (non-empty string) required" });
            return;
        }
        const timeoutMs = Number(req.body?.timeoutMs ?? 60_000);
        const pollIntervalMs = 100;
        const fc = deps.session.fridaClient;

        const deadline = Date.now() + timeoutMs;
        let pid: number | null = null;
        let name: string | null = null;

        try {
            while (Date.now() < deadline) {
                const processes = await fc.listProcesses();
                const match = processes.find((p) => p.name.toLowerCase().includes(pattern));
                if (match) {
                    pid = match.pid;
                    name = match.name;
                    break;
                }
                await new Promise((r) => setTimeout(r, pollIntervalMs));
            }

            if (pid === null) {
                res.status(408).json({ error: `no process matching '${pattern}' appeared within ${timeoutMs}ms` });
                return;
            }

            // Two-phase attach. We want to arm the network capture as soon
            // as humanly possible — between the agent loading and arming,
            // every WS frame the game sends is missed. So:
            //   1. fridaClient.attach() — agent loaded, IL2CPP up
            //   2. detectBuildId + load profile config from disk (fast)
            //   3. armNetworkCapture (CRITICAL — hook installs here)
            //   4. session.attach (skipFridaAttach) — slow stuff: fingerprints,
            //      migrations, label loading. Game can talk during this and
            //      frames are now being captured.
            await fc.attach(pid);

            let preArmedCount = 0;
            try {
                const detected = await detectBuildId(fc);
                const dataPath = await fc.call<string>("getDataPath").catch(() => "");
                const seg = dataPath.split(/[\\/]/).filter(Boolean).pop() ?? "";
                const gameName = seg.replace(/_Data$/i, "").toLowerCase() || "unknown-process";
                const existing = await deps.session.profileManager.loadProfile(gameName, detected.buildId).catch(() => null);
                if (existing) {
                    const networkStorage = new DiskPluginStorage(existing.rootPath, "network");
                    const cfgStore = new SerializerConfigStore(networkStorage);
                    const config = cfgStore.get();
                    const enabled = config.entries.filter((e) => !e.disabled);
                    if (enabled.length > 0) {
                        await fc.call("armNetworkCapture", [config]);
                        preArmedCount = enabled.length;
                    }
                }
            } catch (e) {
                console.warn("[watch-and-attach] pre-arm failed:", e);
            }

            // Now run the full attach (fingerprints, migrations, etc.). The
            // dofus plugin's profile-attached handler will also auto-arm,
            // but it's idempotent on the same config.
            const profile = await deps.session.attach(pid, { skipFridaAttach: true });

            res.json({
                pid, name,
                profile: serializeProfile(profile),
                netCaptureArmed: preArmedCount > 0,
                preArmedSerializers: preArmedCount,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        }
    });

    // Spawn-gating + attach. Frida pauses every new OS spawn at creation;
    // we watch for one matching `processNamePattern`, attach + arm hooks while
    // it's paused, THEN resume it. This guarantees the agent is in place
    // before the game's IL2CPP/Unity runtime even initializes — so the very
    // first WS frame (and everything before) goes through our hooks.
    //
    // Body: { processNamePattern: string, timeoutMs?: number }
    // Note: spawn-gating is system-wide. Any other process spawned during the
    // wait window will be auto-resumed by us so we don't freeze the OS.
    app.post("/api/profile/gate-and-attach", async (req, res) => {
        const pattern = String(req.body?.processNamePattern ?? "").toLowerCase();
        if (!pattern) {
            res.status(400).json({ error: "processNamePattern (non-empty string) required" });
            return;
        }
        const timeoutMs = Number(req.body?.timeoutMs ?? 60_000);
        const fc = deps.session.fridaClient;
        let gatingEnabled = false;
        let pid: number | null = null;

        try {
            await fc.enableSpawnGating();
            gatingEnabled = true;

            const spawn = await fc.waitForSpawn(pattern, timeoutMs);
            if (!spawn) {
                res.status(408).json({ error: `no spawned process matching '${pattern}' within ${timeoutMs}ms` });
                return;
            }
            pid = spawn.pid;

            // Process is paused. Load agent (still paused — agent-ready can't
            // fire yet). Pre-queue armNetworkCapture. Then resume.
            await fc.attach(pid, { suspended: true });

            // Build the arm config from disk (we don't have a profile yet but
            // we know the build id matches — derive it before we resume so
            // file reads happen against the suspended process).
            let preArmedCount = 0;
            let armP: Promise<unknown> = Promise.resolve();
            try {
                const detected = await detectBuildId(fc);
                const dataPath = await fc.call<string>("getDataPath").catch(() => "");
                const seg = dataPath.split(/[\\/]/).filter(Boolean).pop() ?? "";
                const gameName = seg.replace(/_Data$/i, "").toLowerCase() || "unknown-process";
                const existing = await deps.session.profileManager.loadProfile(gameName, detected.buildId).catch(() => null);
                if (existing) {
                    const networkStorage = new DiskPluginStorage(existing.rootPath, "network");
                    const cfgStore = new SerializerConfigStore(networkStorage);
                    const config = cfgStore.get();
                    const enabled = config.entries.filter((e) => !e.disabled);
                    if (enabled.length > 0) {
                        // Fire-and-forget while suspended — promise resolves
                        // post-resume once Il2Cpp.perform fires.
                        armP = fc.call("armNetworkCapture", [config]);
                        preArmedCount = enabled.length;
                    }
                }
            } catch (e) {
                console.warn("[gate-and-attach] pre-arm prep failed:", e);
            }

            // Resume → IL2CPP boots → queued performs fire (agent-ready, then arm).
            await fc.resume(pid);

            // Wait for agent + arm to complete in order.
            await fc.waitForAgentReady();
            await armP.catch((e) => console.warn("[gate-and-attach] arm awaited:", e));

            // Now run the full attach for the rest (fingerprints, migrations).
            const profile = await deps.session.attach(pid, { skipFridaAttach: true });

            res.json({
                pid,
                identifier: spawn.identifier,
                profile: serializeProfile(profile),
                netCaptureArmed: preArmedCount > 0,
                preArmedSerializers: preArmedCount,
            });
        } catch (err) {
            if (pid !== null) {
                try { await fc.detach(); } catch {}
            }
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        } finally {
            if (gatingEnabled) {
                try { await fc.disableSpawnGating(); } catch {}
            }
        }
    });

    // Child-gating via launcher. Attaches to a parent process (e.g. the
    // Ankama Launcher), enables child-gating on that session, and waits for
    // it to spawn a child matching `childNamePattern`. Frida pauses the
    // child until we resume it — so our agent + hooks install in a frozen
    // process, before its IL2CPP/Unity runtime even initializes.
    //
    // Body: { launcherNamePattern, childNamePattern, timeoutMs? }
    //   launcherNamePattern: case-insensitive substring of the launcher
    //     process name, e.g. "ankama launcher".
    //   childNamePattern: substring of the child name to gate, e.g. "dofus".
    app.post("/api/profile/gate-via-launcher", async (req, res) => {
        const launcherPattern = String(req.body?.launcherNamePattern ?? "").toLowerCase();
        const childPattern = String(req.body?.childNamePattern ?? "").toLowerCase();
        if (!launcherPattern || !childPattern) {
            res.status(400).json({ error: "launcherNamePattern and childNamePattern required" });
            return;
        }
        const timeoutMs = Number(req.body?.timeoutMs ?? 60_000);
        const fc = deps.session.fridaClient;
        const dev = await frida.getLocalDevice();

        const processes = await dev.enumerateProcesses();
        const launchers = processes.filter((p) => p.name.toLowerCase().includes(launcherPattern));
        if (launchers.length === 0) {
            res.status(404).json({ error: `no running process matching '${launcherPattern}'` });
            return;
        }

        // Electron apps spawn multiple processes (main, renderer, GPU, …).
        // We don't know which one spawns Dofus, so we attach + gate ALL of
        // them in parallel and listen for any matching child via the device.
        const launcherSessions: frida.Session[] = [];
        const launcherPids = new Set<number>();
        let childPid: number | null = null;
        let childIdentifier = "";
        try {
            for (const p of launchers) {
                try {
                    const s = await dev.attach(p.pid);
                    await s.enableChildGating();
                    launcherSessions.push(s);
                    launcherPids.add(p.pid);
                } catch (e) {
                    console.warn(`[gate-via-launcher] attach failed for ${p.name} pid=${p.pid}:`, e instanceof Error ? e.message : e);
                }
            }
            if (launcherSessions.length === 0) {
                res.status(500).json({ error: `attached to 0 launcher processes (out of ${launchers.length} candidates)` });
                return;
            }

            childPid = await new Promise<number | null>((resolve) => {
                let done = false;
                const finish = (v: number | null): void => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    try { dev.childAdded.disconnect(onChild); } catch {}
                    resolve(v);
                };
                const onChild = (child: frida.Child): void => {
                    if (!launcherPids.has(child.parentPid)) return;
                    const id = (child.identifier ?? child.path ?? "").toLowerCase();
                    if (id.includes(childPattern)) {
                        childIdentifier = child.identifier ?? child.path ?? "";
                        finish(child.pid);
                    } else {
                        dev.resume(child.pid).catch(() => { /* best-effort */ });
                    }
                };
                dev.childAdded.connect(onChild);
                const timer = setTimeout(() => finish(null), timeoutMs);
            });

            if (childPid === null) {
                res.status(408).json({ error: `no gated child matching '${childPattern}' within ${timeoutMs}ms (${launcherSessions.length} launcher session(s) watched)` });
                return;
            }

            // Attach our agent to the suspended child.
            await fc.attach(childPid, { suspended: true });

            // Pre-queue armNetworkCapture (fires once IL2CPP boots post-resume).
            let preArmedCount = 0;
            let armP: Promise<unknown> = Promise.resolve();
            try {
                const detected = await detectBuildId(fc);
                const dataPath = await fc.call<string>("getDataPath").catch(() => "");
                const seg = dataPath.split(/[\\/]/).filter(Boolean).pop() ?? "";
                const gameName = seg.replace(/_Data$/i, "").toLowerCase() || "unknown-process";
                const existing = await deps.session.profileManager.loadProfile(gameName, detected.buildId).catch(() => null);
                if (existing) {
                    const networkStorage = new DiskPluginStorage(existing.rootPath, "network");
                    const cfgStore = new SerializerConfigStore(networkStorage);
                    const config = cfgStore.get();
                    const enabled = config.entries.filter((e) => !e.disabled);
                    if (enabled.length > 0) {
                        armP = fc.call("armNetworkCapture", [config]);
                        preArmedCount = enabled.length;
                    }
                }
            } catch (e) {
                console.warn("[gate-via-launcher] pre-arm prep failed:", e);
            }

            // Resume — IL2CPP boots, queued performs fire in order:
            //   1. agent-ready signal
            //   2. armNetworkCapture installs hooks
            // Game's C# code then runs with hooks in place.
            await fc.resume(childPid);

            await fc.waitForAgentReady();
            await armP.catch((e) => console.warn("[gate-via-launcher] arm awaited:", e));

            const profile = await deps.session.attach(childPid, { skipFridaAttach: true });

            res.json({
                pid: childPid,
                identifier: childIdentifier,
                launchersWatched: launcherSessions.length,
                profile: serializeProfile(profile),
                netCaptureArmed: preArmedCount > 0,
                preArmedSerializers: preArmedCount,
            });
        } catch (err) {
            if (childPid !== null) {
                try { await fc.detach(); } catch {}
                try { await dev.resume(childPid); } catch {}
            }
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        } finally {
            for (const s of launcherSessions) {
                try { await s.disableChildGating(); } catch {}
                try { await s.detach(); } catch {}
            }
        }
    });

    // Freeze-and-attach. PowerShell polls the process list and calls
    // NtSuspendProcess the instant a matching process appears (typical
    // detection latency: 50ms). We then attach Frida + pre-queue
    // armNetworkCapture into the suspended process; Unity hasn't even started
    // initializing IL2CPP yet. Then we NtResumeProcess — Unity boots,
    // queued Il2Cpp.perform callbacks fire (agent-ready then arm), and the
    // game's first WS frame goes straight through our hook.
    //
    // Body: { processNamePattern, timeoutMs? }
    app.post("/api/profile/freeze-and-attach", async (req, res) => {
        const pattern = String(req.body?.processNamePattern ?? "");
        if (!pattern) {
            res.status(400).json({ error: "processNamePattern (non-empty string) required" });
            return;
        }
        const timeoutMs = Number(req.body?.timeoutMs ?? 60_000);
        // Optional method hooks to pre-arm (installed inside the agent's first
        // Il2Cpp.perform, BEFORE agent-ready and before any game C# code runs).
        // Each entry: { className, methodName, ns? }.
        const methodHooks = Array.isArray(req.body?.methodHooks) ? req.body.methodHooks : [];
        const fc = deps.session.fridaClient;
        let pid: number | null = null;

        try {
            const watched = await watchAndSuspendProcess(pattern, timeoutMs);
            if (watched === null) {
                res.status(408).json({ error: `no process matching '${pattern}' appeared within ${timeoutMs}ms` });
                return;
            }
            pid = watched.pid;

            // ALL Frida RPC calls eventually use Il2Cpp.perform internally;
            // those queue until IL2CPP initializes (i.e. until resume). So we
            // resolve the buildId + load the profile + serializer config
            // FROM DISK (no Frida calls) while the process is still frozen.
            const fsLib = await import("node:fs/promises");
            const pathLib = await import("node:path");
            let preArmedCount = 0;
            let cfgForLog: unknown = null;
            try {
                const exeDir = pathLib.dirname(watched.exePath);
                const exeName = pathLib.basename(watched.exePath, ".exe");
                const dataPath = pathLib.join(exeDir, `${exeName}_Data`);
                const bootCfg = await fsLib.readFile(pathLib.join(dataPath, "boot.config"), "utf-8").catch(() => "");
                const m = /build-guid=([0-9a-f]+)/i.exec(bootCfg);
                const buildId = m ? m[1] : null;
                const gameName = exeName.toLowerCase();
                if (buildId) {
                    const existing = await deps.session.profileManager.loadProfile(gameName, buildId).catch(() => null);
                    if (existing) {
                        const networkStorage = new DiskPluginStorage(existing.rootPath, "network");
                        const cfgStore = new SerializerConfigStore(networkStorage);
                        const config = cfgStore.get();
                        cfgForLog = config;
                        const enabled = config.entries.filter((e) => !e.disabled);
                        if (enabled.length > 0) {
                            preArmedCount = enabled.length;
                        }
                    }
                }
            } catch (e) {
                console.warn("[freeze-and-attach] disk-only pre-arm prep failed:", e);
            }

            // Process is frozen (all current threads suspended). Frida can
            // still inject its agent thread (NtSuspendProcess only suspends
            // EXISTING threads at the time of call, not future ones).
            await fc.attach(pid, { suspended: true });

            // Critical timing fix: send the serializer config to the agent via
            // a Frida message BEFORE we resume. The agent's index.ts stores
            // it in a module-level var and reads it inside the FIRST
            // Il2Cpp.perform — installing the hooks BEFORE sending
            // agent-ready. That eliminates the race window where the game's
            // initialization runs between Il2Cpp.perform firing and our arm
            // RPC being processed.
            if (cfgForLog && preArmedCount > 0) {
                try {
                    await fc.postPreArmConfig(cfgForLog);
                } catch (e) {
                    console.warn("[freeze-and-attach] postPreArmConfig failed:", e);
                    preArmedCount = 0;  // signal failure to caller
                }
            }
            if (methodHooks.length > 0) {
                try {
                    await fc.postPreArmMethods(methodHooks);
                } catch (e) {
                    console.warn("[freeze-and-attach] postPreArmMethods failed:", e);
                }
            }

            // Unfreeze — Unity boots, IL2CPP inits, agent's first perform
            // installs hooks then sends agent-ready. By the time the game's
            // C# code runs its first network operation, the hook is in place.
            await resumeProcess(pid);

            await fc.waitForAgentReady();

            const profile = await deps.session.attach(pid, { skipFridaAttach: true });

            res.json({
                pid,
                exePath: watched.exePath,
                profile: serializeProfile(profile),
                netCaptureArmed: preArmedCount > 0,
                preArmedSerializers: preArmedCount,
            });
        } catch (err) {
            if (pid !== null) {
                // Always resume — never leave the process frozen on error.
                await resumeProcess(pid);
                try { await fc.detach(); } catch {}
            }
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        }
    });

    app.post("/api/profile/detach", async (_req, res) => {
        try {
            await deps.session.detach();
            res.json({ ok: true });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        }
    });
}
