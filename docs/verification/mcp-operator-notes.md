## MCP Operator Notes

Date: 2026-05-21

### Supported Transports

- Streamable HTTP: preferred remote MCP path for current HTTP servers.
- HTTP: JSON-RPC POST against a configured MCP endpoint.
- SSE: legacy MCP SSE endpoint plus POST callback flow.
- Stdio Bridge: browser talks to a local HTTP bridge; the bridge owns process launch and stdio.
- Native Messaging: the browser talks to an installed native messaging host.

Reference specs:

- Lifecycle: https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
- Transports: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- Tools: https://modelcontextprotocol.io/specification/draft/server/tools

### Reload Requirements

After source changes:

1. Run the build command for the target browser.
2. Open the browser extension management page.
3. Reload the matching unpacked extension directory.
4. Refresh existing `https://chat.deepseek.com/` tabs so the content and main-world scripts pick up the new bundle.

| Browser | Command | Reload target |
|:--|:--|:--|
| Chrome | `npm run build:chrome` | `dist/chrome-mv3/` in `chrome://extensions/` |
| Edge | `npm run build:edge` | `dist/edge-mv3/` in `edge://extensions/` |
| Firefox | `npm run build:firefox` | `dist/firefox-mv3/manifest.json` in `about:debugging#/runtime/this-firefox` |

### MCP Setup Checklist

1. Open the DeepSeek++ sidepanel.
2. Go to `MCP`.
3. Add a server and choose its transport.
4. For HTTP/SSE/bridge transports, click `授权` and approve the browser host permission.
5. Click `测试` to verify initialize/list behavior and latency.
6. Click `刷新工具` to populate the cache.
7. Confirm each tool's enabled state. Only tools with server `auto` policy and enabled tool state are injected into prompts.

### Shell MCP And OfficeCLI

OfficeCLI document work now uses the Shell Native Messaging MCP host. The browser extension still does not execute local commands itself; it sends `shell_exec` calls to the installed native host.

Install the native host and command-based OfficeCLI:

```bash
npx @tflystar/deepseek-pp-shell-host install --browser chrome --extension-id <extension-id>
```

Use `--browser edge`, `--browser chromium`, or `--browser firefox` for those targets. Firefox uses its fixed extension ID and does not need `--extension-id`. The installer detects the user's OS/CPU, installs the Shell Native Host into the user's profile directory, downloads the matching single-binary asset from `iOfficeAI/OfficeCLI`, verifies `SHA256SUMS` when available, and installs OfficeCLI to `~/.local/bin/officecli` on macOS/Linux or `%LOCALAPPDATA%\OfficeCLI\officecli.exe` on Windows. Pass `--skip-officecli` only when OfficeCLI is managed separately.

Developers running from the source checkout can use the equivalent local wrapper:

```bash
npm run shell:install -- --browser chrome --extension-id <extension-id>
```

After installation, create the sidepanel `Shell` preset, then test and refresh tools.

The built-in `/officecli` skill must use the command-based OfficeCLI surface through `shell_exec`. Before touching a document, verify that the selected binary supports the scripted commands:

```bash
which -a officecli || true
officecli --version
officecli --help | sed -n '1,140p'
```

The acceptable OfficeCLI help output includes commands such as `view`, `get`, `set`, `add`, `validate`, and `batch`, plus global `--json`. If the selected binary only exposes hosted-generation commands such as `new`, `doctor`, `login`, `set-key`, `config`, or `upgrade`, do not call `new --prompt`; switch the OfficeCLI binary first.

### Verification Commands

```bash
npm run verify:mcp:mock
npm run smoke:mcp
npm run smoke:shell
npm run compile
npm run build:all
```

For browser manual verification with a loopback server:

```bash
node scripts/mcp-live-mock.mjs --serve
```

Use the printed URL as a Streamable HTTP MCP server in the sidepanel.

### Limits

- Connect timeout: 10,000 ms by default.
- Request timeout: 60,000 ms by default.
- Discovery timeout: 20,000 ms by default.
- Max result bytes: 64,000 by default.
- Max tool count per server: 128 by default.
- Manual chat and automation MCP continuations are capped at 3 rounds; the inline continuation UI can keep showing restored Step records after page refresh.

### Local Files

- The extension does not read arbitrary local files or launch stdio MCP processes directly from the browser sandbox.
- Filesystem tools must be exposed by a configured MCP server, Stdio Bridge, or Native Messaging host.
- Keep filesystem MCP roots narrow, and prefer allowlisted project directories over full-disk access.
- Tool call path arguments must still be valid JSON strings. Use `D:/project/file.txt` or escaped backslashes such as `D:\\project\\file.txt`.

### Troubleshooting

- `mcp_origin_permission_denied`: grant host permission from the MCP sidepanel or remove/re-add the server URL.
- `mcp_endpoint_invalid`: use an `http://` or `https://` URL for browser transports.
- `mcp_sse_endpoint_missing`: the SSE server did not emit the endpoint event expected by the legacy transport.
- `mcp_native_host_unavailable`: install or fix the browser native messaging host manifest.
- Local filesystem MCP returns permission errors: check the MCP server or bridge root allowlist. The browser extension cannot bypass that local policy.
- Tool call is shown as a format error: verify the XML tag name is available and the body is a JSON object with escaped backslashes.
- Tool is discovered but not injected: check server enabled state, execution mode, and per-tool allow/deny state.
- Tool executes once but does not continue: verify the current DeepSeek page has the latest extension content script. Manual chat and automation continuations may continue MCP tool calls for up to 3 rounds when tool schemas are still available.
- Stdio server does not start: verify the bridge process, command, args, cwd, and env. The extension itself does not launch stdio processes directly.
- `mcp_native_host_unavailable`: run `npx @tflystar/deepseek-pp-shell-host install ...`, then restart the browser.
- `Access to the specified native messaging host is forbidden`: the host is installed but the manifest does not allow the current extension ID; rerun `npx @tflystar/deepseek-pp-shell-host install ...` with the ID shown in the MCP sidepanel.
- `officecli: command not found`: rerun `npx @tflystar/deepseek-pp-shell-host install ...` or place command-based OfficeCLI under `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, or `%LOCALAPPDATA%\OfficeCLI`.
- OfficeCLI help only shows hosted generation commands: the wrong binary is first on `PATH`; remove the npm wrapper from the project or put the command-based binary earlier on `PATH`.
- `officecli_file_locked`: close the document in other OfficeCLI resident/watch sessions or external editors, then retry.
- Visible `<shell_exec>` text in the chat with no tool card means the current DeepSeek page did not execute that tag. Refresh the DeepSeek page after reloading the extension or refreshing MCP tools so the content script receives the latest tool descriptor list.
