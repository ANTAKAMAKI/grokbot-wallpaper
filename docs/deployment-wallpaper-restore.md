# Deploy and roll back the wallpaper helper

This file is for the parent agent to use on the user's Mac **after review**. Nothing in this repository run deployed the helper, restarted Grok Bot, or checked the screen.

The cloud VM ran `node --test test/wallpaper.test.mjs` on Node v22.23.4 (Linux). That is not macOS, not Grok Bot, and not a visual check. The user's runtime is Node v26.13.1 at `/Users/Admin1/.local/node-v26.13.1-darwin-arm64/bin/node`, which satisfies the helper's Node 22+ requirement. Do not install another Node, Python, or developer tools.

## What is being replaced

| | Previous helper | This helper |
| --- | --- | --- |
| Git commit | `d002d73038b77a4db569de8186215f9d3eced8ce` | this branch |
| Path in repo | `scripts/grokbot-wallpaper.mjs` | `scripts/grokbot-wallpaper.mjs` |
| Installed path | `/Users/Admin1/Library/Application Support/grokbot-wallpaper/scripts/grokbot-wallpaper.mjs` | same path |
| SHA-256 | `faeae1b99e4b1577c53b7b416c4937b1e64e38633237e8f8a640f293160288c9` | `4cdd9419d6b41af202ac33b0d77eb0ace4d950cd0c5ea4036b9916e51c90f796` |
| Size | 36197 bytes | 84892 bytes |

Image to keep, unchanged:

- `/Users/Admin1/Library/Application Support/grokbot-wallpaper/selected-wallpaper.png`
- SHA-256 `0c1591687739b76dba495df86e15e50b46168187d4ebdc8b3c5ffc37be77f0d3`
- 3298387 bytes, PNG 2880x1330

Settings to keep: opacity `0.94`, appearance `dark`. Do not pass a different opacity. Do not crop or recompress the PNG. A file under 4MB is copied as-is.

## What requires the user's approval

1. Replacing the helper file with the hash above.
2. One `apply` **without** `--relaunch`, which rewrites the LaunchAgent and asks `launchd` to stop the old helper. That stop is `launchd`'s normal stop of `com.kingao.grokbot-wallpaper`, not a kill of Grok Bot.
3. Only if a **manual** old `watch` is still listening on `127.0.0.1:19223` after that: one `SIGTERM` to that exact helper pid, after the command line is checked. Never `SIGKILL`. Never signal Grok Bot for this step.
4. A later visual test that opens Grok Bot from the Dock can cause the new helper to AppleScript-quit and reopen **once** if that launch has no loopback debug port. Treat that reopen as its own approval. Do not do it in a loop.

No new macOS permission, login item, cron job, or calendar schedule is required. If macOS asks for Automation, Accessibility, Full Disk Access, or any other prompt while `osascript` starts, stop and ask. Do not approve it silently.

## Deploy

Do this on the user's Mac, from a shell that is not a child of Grok Bot, so quitting the app later cannot kill the shell. Abort if a hash does not match.

```bash
NODE="/Users/Admin1/.local/node-v26.13.1-darwin-arm64/bin/node"
DIR="$HOME/Library/Application Support/grokbot-wallpaper"
HELPER="$DIR/scripts/grokbot-wallpaper.mjs"
IMAGE="$DIR/selected-wallpaper.png"
PLIST="$HOME/Library/LaunchAgents/com.kingao.grokbot-wallpaper.plist"
NEW="/path/to/reviewed/grokbot-wallpaper.mjs"   # the file whose SHA-256 is 4cdd9419...

shasum -a 256 "$HELPER" "$IMAGE"
# helper must still be faeae1b99e4b1577c53b7b416c4937b1e64e38633237e8f8a640f293160288c9
# image must be 0c1591687739b76dba495df86e15e50b46168187d4ebdc8b3c5ffc37be77f0d3

cp -p "$HELPER" "$DIR/scripts/grokbot-wallpaper.mjs.bak-d002d730"
cp -p "$PLIST" "$DIR/com.kingao.grokbot-wallpaper.plist.bak" 2>/dev/null || true
cp "$NEW" "$HELPER"
shasum -a 256 "$HELPER"
# must be 4cdd9419d6b41af202ac33b0d77eb0ace4d950cd0c5ea4036b9916e51c90f796

# Read-only process check. Do not signal anything in this block.
ps -axww -o pid=,command= | grep -F 'grokbot-wallpaper' | grep -v grep
lsof -nP -iTCP:19222 -sTCP:LISTEN
lsof -nP -iTCP:19223 -sTCP:LISTEN
```

If `19222` is `127.0.0.1` and owned by Grok Bot, do not quit Grok Bot. The expected case on 2026-11-25 is Grok Bot pid 22280 with that debug port, and one helper watch (pid 30957) from the existing LaunchAgent.

Then one apply, still without `--relaunch`:

```bash
"$NODE" "$HELPER" apply "$IMAGE" --opacity 0.94 --dark
echo "apply_exit=$?"
"$NODE" "$HELPER" status
```

`apply` rewrites the LaunchAgent. The new plist keeps `RunAtLoad`, sets `KeepAlive` to restart only after a crash (`SuccessfulExit` false), sets `ThrottleInterval` to 10 seconds, and sets `GROKBOT_WALLPAPER_AGENT=1`. It does not add a calendar or interval. If `launchctl bootstrap` prints `5: Input/output error` and the service is not actually loaded, stop. The helper does not retry that bootstrap. Read:

```bash
tail -n 80 "$DIR/watch.log"
cat "$DIR/diagnostic.json" 2>/dev/null || true
launchctl print "gui/$(id -u)/com.kingao.grokbot-wallpaper" || true
ps -axww -o pid=,ppid=,command= | grep -F 'grokbot-wallpaper' | grep -v grep
lsof -nP -iTCP:19223 -sTCP:LISTEN
```

Success for this step is process-level only:

- exactly one `grokbot-wallpaper` `watch` process
- `127.0.0.1:19223` owned by that process
- `status` shows `panel: true`, `panelProtocol: 2`, `debug: true` if the app was already debuggable
- `lastApplied.opacity` is `0.94`, `appearance` is `dark`, `sha256` is `0c1591687739b76dba495df86e15e50b46168187d4ebdc8b3c5ffc37be77f0d3`
- `visibility` is `not-checked`

`status` does **not** mean the picture is on screen. The parent must look at the Grok Bot window.

If `19223` is still held by an old helper whose `/health` has no `"protocol":2`, the new process exits instead of signaling it. After approval, send one `SIGTERM` to that pid only if `ps` shows its command is this helper's `watch`, wait until that pid is gone, and run the same `apply` **once** more. If it is still there, stop. Do not use `SIGKILL`.

## What the parent must look at

On the Mac, with the original PNG:

- the custom image is visible in the current window after the apply above, without treating `status` as proof
- it stays visible across chat switch, bot switch, back navigation, and reload
- after a separately approved normal reopen, it comes back, and the command line contains `--remote-debugging-port=19222` and `--remote-debugging-address=127.0.0.1`
- there is still one helper process, no growing pid list, and no repeated quit

`watch.log` should show a `launch` record when Grok Bot actually opens. The helper must not open Grok Bot by itself at login. If the log says `launch-monitor-down`, the open/quit notifications are not arriving. Do not add a poll to paper over that. The current debug session can still be repaired at helper start; later launches would be missed until the monitor runs.

## Rollback

```bash
NODE="/Users/Admin1/.local/node-v26.13.1-darwin-arm64/bin/node"
DIR="$HOME/Library/Application Support/grokbot-wallpaper"
HELPER="$DIR/scripts/grokbot-wallpaper.mjs"
UID_NUM="$(id -u)"

launchctl bootout "gui/$UID_NUM/com.kingao.grokbot-wallpaper" || true
cp "$DIR/scripts/grokbot-wallpaper.mjs.bak-d002d730" "$HELPER"
shasum -a 256 "$HELPER"
# must be faeae1b99e4b1577c53b7b416c4937b1e64e38633237e8f8a640f293160288c9

if [ -f "$DIR/com.kingao.grokbot-wallpaper.plist.bak" ]; then
  cp "$DIR/com.kingao.grokbot-wallpaper.plist.bak" "$HOME/Library/LaunchAgents/com.kingao.grokbot-wallpaper.plist"
fi
```

Restoring the old file brings back the old behavior, including the polling loop and the missing panel handover. Do not claim that rollback preserves the fix. Leave Grok Bot running unless the user approves a quit. The in-memory overlay disappears only when that process quits or `restore` runs against the debug port.

The image file and the Node installation stay where they are in both deploy and rollback.
