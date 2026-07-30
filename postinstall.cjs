#!/usr/bin/env node
/**
 * MINDIGENOUS — postinstall welcome + system check.
 *
 * Runs automatically at the end of `npm install -g mindigenous`.
 * Prints an intro guide AND a live system check so a brand-new user
 * instantly understands:
 *   WHAT they installed, WHY Node/npm was needed, WHAT their system
 *   already has (Node version, git, AI API keys), and EXACTLY which
 *   command to run next — without hunting through docs.
 *
 * Rules:
 *  - Only prints for GLOBAL installs (silent for library/dev installs).
 *  - Must NEVER fail the install: every check is wrapped, errors swallowed.
 */

try {
  // npm sets this for `npm install -g ...`. Silent otherwise (dependency
  // installs, repo dev installs, CI, ...).
  if (process.env.npm_config_global !== "true") process.exit(0);

  const { spawnSync } = require("node:child_process");
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");

  const c = (code, s) => `[${code}m${s}[0m`;
  const cyan = (s) => c("36", s);
  const bold = (s) => c("1", s);
  const dim = (s) => c("2", s);
  const green = (s) => c("32", s);
  const yellow = (s) => c("33", s);
  const red = (s) => c("31", s);

  const ok = green("OK");
  const warn = yellow("CHECK");
  const line = cyan("─".repeat(62));

  // ------------------------------------------------------------------
  // Check 1: Node.js version (the engine the agent runs on — need v22+)
  // ------------------------------------------------------------------
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeOk = nodeMajor >= 22;
  const nodeLine = nodeOk
    ? `  ${ok}     Node.js ${process.version} ${dim("(engine the agent runs on)")}`
    : `  ${warn}  Node.js ${process.version} — ${yellow("too old, v22+ required.")} Upgrade: ${cyan("winget install OpenJS.NodeJS.LTS")} ${dim("(Windows)")} or nodejs.org`;

  // ------------------------------------------------------------------
  // Check 2: git (lets the agent use its git tools on your projects)
  // ------------------------------------------------------------------
  let gitLine;
  try {
    const g = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const v = (g.stdout || "").trim();
    gitLine = g.status === 0 && v
      ? `  ${ok}     ${v} ${dim("(agent can use git tools)")}`
      : `  ${warn}  git not found ${dim("— optional, but enables the agent's git tools: https://git-scm.com")}`;
  } catch {
    gitLine = `  ${warn}  git not found ${dim("— optional, but enables the agent's git tools: https://git-scm.com")}`;
  }

  // ------------------------------------------------------------------
  // Check 3: AI API keys already on this machine.
  // The agent needs at least ONE provider key to think. We scan the same
  // places the app's onboarding does, so we can tell the user upfront.
  // ------------------------------------------------------------------
  const ENV_KEYS = [
    ["OPENAI_API_KEY", "OpenAI"],
    ["GEMINI_API_KEY", "Google Gemini"],
    ["ANTHROPIC_API_KEY", "Anthropic Claude"],
    ["GROQ_API_KEY", "Groq"],
    ["DEEPSEEK_API_KEY", "DeepSeek"],
    ["TOGETHER_API_KEY", "Together AI"],
    ["FIREWORKS_API_KEY", "Fireworks AI"],
    ["OPENROUTER_API_KEY", "OpenRouter"],
    ["TOKENROUTER_API_KEY", "TokenRouter"],
  ];

  const mask = (k) =>
    k.length <= 10 ? "••••••" : `${k.slice(0, 6)}${"•".repeat(8)}${k.slice(-4)}`;

  const found = [];
  const seen = new Set();
  const addKey = (label, key, source) => {
    if (!key || key.length <= 10 || seen.has(key)) return;
    seen.add(key);
    found.push({ label, key, source });
  };

  // 3a. Environment variables
  for (const [env, label] of ENV_KEYS) {
    try { addKey(label, process.env[env], `env var ${env}`); } catch { /* skip */ }
  }

  // 3b. Claude Code credentials (~/.claude/credentials.json)
  try {
    const credPath = path.join(os.homedir(), ".claude", "credentials.json");
    if (fs.existsSync(credPath)) {
      const json = JSON.parse(fs.readFileSync(credPath, "utf8"));
      addKey("Anthropic Claude", json.apiKey ?? json.anthropic_api_key ?? json.ANTHROPIC_API_KEY, "Claude Code config");
    }
  } catch { /* skip */ }

  // 3c. .env files (home directory + current directory)
  const envFilePattern = /(OPENAI|GEMINI|ANTHROPIC|GROQ|DEEPSEEK|TOGETHER|FIREWORKS|OPENROUTER|TOKENROUTER)_API_KEY\s*=\s*["']?([^\s"'\r\n]+)/g;
  for (const file of [path.join(os.homedir(), ".env"), path.join(process.cwd(), ".env")]) {
    try {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, "utf8");
      let m;
      while ((m = envFilePattern.exec(content)) !== null) {
        const entry = ENV_KEYS.find(([e]) => e === `${m[1]}_API_KEY`);
        addKey(entry ? entry[1] : m[1], m[2], file);
      }
    } catch { /* skip */ }
  }

  const keyLines = found.length > 0
    ? found.map((f) => `  ${ok}     ${f.label} key found ${dim(`(${mask(f.key)} — ${f.source})`)}`)
    : [
        `  ${warn}  No AI API keys found yet.`,
        `         ${dim("The first-run setup will help you add one — a free")}`,
        `         ${dim("Google AI Studio (Gemini) key is the easiest start.")}`,
      ];

  // ------------------------------------------------------------------
  // Render the banner
  // ------------------------------------------------------------------
  const banner = `
${line}
  ${bold("MINDIGENOUS")} ${dim("—")} agentic coding terminal installed successfully
${line}

  ${bold("What is this?")}
  An AI coding agent that lives in your terminal. Chat with it in plain
  English — it reads your project, writes code, creates files, runs safe
  commands, searches the web, and analyzes images. You pick ANY model as
  its brain; the runtime gives that brain the tools it is missing.

  ${bold("Why did I need Node.js / npm?")}
  The agent's runtime is built on Node.js. Installing Node (which includes
  npm) was a one-time step — from here on you only ever use one command.

  ${bold("Your system check:")}
${nodeLine}
${gitLine}
${keyLines.join("\n")}

  ${bold("Start now")} ${green("— just one command:")}

      ${bold(cyan("mindi"))}

  First launch finishes the setup with you: it confirms the keys above
  (or helps you add one), lets you pick your model, and drops you into
  the chat. That is the entire workflow.

  ${bold("Useful later (optional):")}
    ${cyan("mindi-cli doctor")}   ${dim("— re-run a full health check anytime")}
    ${cyan("mindi-cli --help")}    ${dim("— power-user commands (scripting, logs)")}

  ${dim("Docs & source:")} https://github.com/Faaz345/mindi-runtime
${line}
`;

  // npm v7+ hides lifecycle-script output, so we write straight to the
  // user's terminal. Note: Node's fs cannot open the console device
  // (libuv's path handling turns CONOUT$ into a regular file), so we go
  // through the system shell's device redirection instead — the same
  // mechanism native installers (rustup, nvm) use to reach piped TTYs:
  //   Windows : cmd /c "type <file> > CON"
  //   mac/Linux: sh -c  "cat <file> > /dev/tty"
  // npm's script children share the user's console, so this lands on
  // their screen during `npm install -g`. Falls back to stdout where
  // there is no console (CI logs) or for package managers that don't
  // suppress script output.
  let shown = false;
  const tmpFile = path.join(os.tmpdir(), `mindigenous-banner-${process.pid}.txt`);
  try {
    fs.writeFileSync(tmpFile, banner, "utf8");
    const r = process.platform === "win32"
      ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `type "${tmpFile}" > CON`], { windowsHide: true, timeout: 15000 })
      : spawnSync("sh", ["-c", `cat "${tmpFile}" > /dev/tty`], { timeout: 15000 });
    shown = r.status === 0;
  } catch { /* no console available */ } finally {
    try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
  }
  if (!shown) {
    try { process.stdout.write(banner); } catch { /* give up silently */ }
  }
} catch {
  // A banner must never break an install.
}
process.exit(0);
