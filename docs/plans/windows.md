# Plan: native Windows support

**Why:** on the PC, servedev runs inside WSL, and WSL is flaky for remote work: when the SSH connection drops, WSL (and every server in it) can die. servedev should run as a Windows program, so servers survive dropped connections and logouts, and the Mac connects to it like any other machine.

**Mockups:** [adding machines (native Windows)](https://claude.ai/artifact/6PCzboWAjEjgCX4vsJhTMp): the Add machine dialog with a detected, editable system type; machine settings with *Change system type*; what detection finds in each case.

## Phase 0: one platform layer (no behavior change)

Everything that assumes Unix goes behind one interface in `src/platform/`: listening ports, the process table and tree, stopping a process tree, starting a command, building the environment, and starting at login. Today's code becomes `posix.ts` (macOS and Linux); `windows.ts` starts as a stub. `manager.ts`, `ports.ts`, `env.ts`, `autostart.ts` and the `/bin/sh` spawning go through it.

## Phase 1: the Windows implementation

| Area | Approach |
|---|---|
| Ports | Parse `netstat -ano` (fast); `Get-NetTCPConnection` as a fallback |
| Process tree | Parent/child ids from `Win32_Process`, with start times so a reused pid isn't mistaken for the old one. Better: each server in a **named Job Object**, so all its children belong to it and a restarted daemon can find it again (native calls through Bun FFI) |
| Stopping | The server's `stop` command first, then Ctrl+Break to its process group, then `taskkill /T /F`. The riskiest part: Windows has no reliable SIGTERM for console programs |
| Starting commands | `pwsh -NoProfile -Command`, or `cmd /d /s /c`, window hidden, output to the log file |
| Environment | The user's and system variables from the registry (the login-shell equivalent) |
| Paths and config | `%LOCALAPPDATA%\servedev`, `C:\` paths, case-insensitive project keys |
| Surviving logout and drops | A scheduled task at boot/logon that restarts on failure (see decision 1); a Windows service needs admin |
| Secrets at rest | Device keys and stored tokens protected with DPAPI / Credential Manager, not only file permissions |
| Install | One `servedev.exe` from `bun build --compile --target=bun-windows-x64`, plus `install.ps1` that needs no admin; winget later |

## Phase 2: connecting from the Mac

- A third machine kind, `windows`, next to `posix` and `wsl`: commands go as PowerShell scripts; port forwarding and access keys work the same.
- One detection probe that works whichever shell SSH lands in (cmd, PowerShell, bash, Git Bash). Saved per machine as `kind` (`windows | wsl | posix`), `kindSource` (`detected | user`; a user's choice is never re-detected) and `shell` (`pwsh | powershell | cmd`, Windows only).
- A detected kind is re-checked on every connect and only *offers* to switch.
- Windows versions of `remote update` and `remote boot`.
- The Add machine and machine settings screens from the mockups.

## Phase 3: hardening

- Tests on a GitHub Actions `windows-latest` runner.
- A real trial on the PC: native and WSL side by side, then switch over.
- Docs.

## Security: per-device access keys

Done separately (works for every machine kind): each hub gets its own access key from the machine over SSH, the machine stores only a hash, and lists the devices that can control it with **Revoke**. The machine's master token never leaves it.

Not doing now: signing each request (HMAC or Ed25519). Everything travels inside SSH, which already encrypts and authenticates, and the realistic attacker is a process running as you that can read any key servedev can. If servedev ever connects without SSH (directly over Tailscale or the internet), switch to Ed25519 request signatures (HTTP Message Signatures, RFC 9421): each device keeps a private key and machines store only public keys.

Later: per-key permissions (e.g. control servers but not edit config or update servedev); rotating the master token.

## Decisions still open

1. Must servers run before anyone logs in to Windows? If so: a stored password or an S4U logon (no network drives). If not, a logon task is enough.
2. When switching the PC from WSL to native, copy the WSL servers' definitions across, or leave them?
3. Allow one PC to appear twice (`pc` native and `pc-wsl`) to use both at once?
