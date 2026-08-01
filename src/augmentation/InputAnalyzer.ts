/**
 * InputAnalyzer — first stage of the Capability Augmentation Router.
 *
 * Parses a raw user request into a structured RequestAnalysis that
 * augmentation modules consume for detection and execution.
 *
 * Pure analysis — no I/O, no side effects. Detects:
 *   - Image attachments and image file paths
 *   - URLs (web pages, repositories)
 *   - Local file paths
 *   - Repository references (GitHub, GitLab, Bitbucket)
 *   - Search/research intent
 *   - Command/terminal intent
 */

import type {
  CommandIntent,
  DetectedFilePath,
  DetectedRepository,
  DetectedUrl,
  ParsedAttachment,
  RequestAnalysis,
  SearchIntent,
} from "./types.js";

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s"'<>)}\]]+/gi;
const GITHUB_REPO_RE = /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/i;
const GITLAB_REPO_RE = /gitlab\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/i;
const BITBUCKET_REPO_RE = /bitbucket\.org\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/i;

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|svg)$/i;
const QUOTED_PATH_RE = /"([^"\r\n]+)"|'([^'\r\n]+)'/g;
const WINDOWS_PATH_RE = /[A-Za-z]:[\\\/][^\s"'<>|*?]+/g;
const UNIX_PATH_RE = /(?:\/[\w.-]+){2,}[\/\w.-]*/g;
const RELATIVE_PATH_RE = /(?:\.{1,2}[\/\\])[\w.\\\/-]+|(?:[\w@.-]+[\/\\]){1,}[\w.-]+\.[\w]+/g;
// Matches: ./path, ../path, AND bare relative paths like src/index.ts, lib/utils.ts, backend/api.py
// The second alternative requires at least one separator + a file extension to avoid false positives.

// Well-known single-file names that are always file references (no separator needed).
const KNOWN_FILE_RE = /\b(?:package\.json|package-lock\.json|tsconfig\.json|README\.md|CHANGELOG\.md|LICENSE|Makefile|Dockerfile|docker-compose\.ya?ml|\.gitignore|\.env(?:\.\w+)?|vitest\.config\.\w+|vite\.config\.\w+|next\.config\.\w+|tailwind\.config\.\w+|postcss\.config\.\w+|eslint\.config\.\w+|prettier\.config\.\w+|webpack\.config\.\w+|rollup\.config\.\w+|jest\.config\.\w+|babel\.config\.\w+|\.babelrc|Cargo\.toml|go\.mod|go\.sum|requirements\.txt|setup\.py|pyproject\.toml|Gemfile|CMakeLists\.txt)\b/g;

const TEXT_FILE_EXT_RE = /\.(?:txt|md|markdown|json|jsonc|ya?ml|csv|tsv|xml|html?|css|s[ac]ss|less|[jt]sx?|mjs|cjs|py|go|rs|java|kt|c|cpp|h|hpp|rb|php|sh|bash|ps1|sql|log|ini|cfg|conf|toml|env|lock)$/i;

const SEARCH_PATTERNS: Array<{ re: RegExp; weight: number; reason: string }> = [
  { re: /\b(search|google|look\s?up|find out|research)\b/i, weight: 0.7, reason: "explicit search verb" },
  { re: /\b(latest|current|recent|today|now|up-to-date|real-time|breaking|news)\b/i, weight: 0.8, reason: "freshness language" },
  { re: /\b(what('?s| is) happening|who (is|are|won)|when (did|was|is)|where (is|are))\b/i, weight: 0.6, reason: "factual question" },
  { re: /\b(stock price|weather|score|result|winner|announcement)\b/i, weight: 0.85, reason: "real-time data" },
];

const COMMAND_PATTERNS: Array<{ re: RegExp; weight: number }> = [
  { re: /\brun\s+(?:this\s+)?(?:command|cmd|shell|script)\b/i, weight: 0.9 },
  { re: /\bexecute\b.{0,30}\b(command|script|program)\b/i, weight: 0.85 },
  { re: /^\s*[$>]\s+/m, weight: 0.8 },
  { re: /\b(npm|pnpm|yarn|node|python|pip|cargo|go run|make|docker)\s+(run|start|test|build|install)\b/i, weight: 0.75 },
];

/** Intent signals that indicate the user wants to MODIFY a repo (needs clone). */
const REPO_MODIFY_RE = /\b(clone|fix|modify|edit|update|refactor|debug|run|test|build|install|contribute|fork|patch|change|add|remove|delete|implement)\b/i;

// ---------------------------------------------------------------------------
// InputAnalyzer
// ---------------------------------------------------------------------------

export class InputAnalyzer {
  /**
   * Analyze a raw user request and produce a structured RequestAnalysis.
   * This is pure detection — no I/O, no network calls, no filesystem access.
   */
  analyze(input: {
    text: string;
    attachments: Array<{ name?: string; mimeType?: string; data?: string }>;
    sessionId: string;
    requestId: string;
  }): RequestAnalysis {
    const { text, attachments, sessionId, requestId } = input;

    const parsedAttachments = this.parseAttachments(attachments);
    const urls = this.detectUrls(text);
    const repositories = this.detectRepositories(text, urls);
    const filePaths = this.detectFilePaths(text, parsedAttachments);
    const searchIntent = this.detectSearchIntent(text);
    const commandIntent = this.detectCommandIntent(text);

    return {
      text,
      attachments: parsedAttachments,
      urls,
      filePaths,
      repositories,
      searchIntent,
      commandIntent,
      sessionId,
      requestId,
    };
  }

  // ---- Attachment parsing ------------------------------------------------

  private parseAttachments(
    attachments: Array<{ name?: string; mimeType?: string; data?: string }>,
  ): ParsedAttachment[] {
    return attachments.map((a) => ({
      name: a.name,
      mimeType: a.mimeType,
      data: a.data,
      kind: classifyAttachmentKind(a.name, a.mimeType),
    }));
  }

  // ---- URL detection -----------------------------------------------------

  private detectUrls(text: string): DetectedUrl[] {
    const matches = text.match(URL_RE) ?? [];
    const seen = new Set<string>();
    const urls: DetectedUrl[] = [];

    for (const raw of matches) {
      // Strip trailing punctuation that regex may have captured.
      const url = raw.replace(/[.,;:!?)\]]+$/, "");
      if (seen.has(url)) continue;
      seen.add(url);

      let domain = "";
      try {
        domain = new URL(url).hostname;
      } catch {
        domain = url.split("/")[2] ?? "";
      }

      urls.push({
        url,
        isRepository: GITHUB_REPO_RE.test(url) || GITLAB_REPO_RE.test(url) || BITBUCKET_REPO_RE.test(url),
        domain,
      });
    }
    return urls;
  }

  // ---- Repository detection ----------------------------------------------

  private detectRepositories(text: string, urls: DetectedUrl[]): DetectedRepository[] {
    const repos: DetectedRepository[] = [];
    const seen = new Set<string>();

    // Check URLs first.
    for (const u of urls) {
      if (!u.isRepository) continue;
      const repo = parseRepoUrl(u.url, text);
      if (repo && !seen.has(repo.fullName)) {
        seen.add(repo.fullName);
        repos.push(repo);
      }
    }

    // Also check for bare "owner/repo" mentions with git context.
    const bareRepo = text.match(/\b(?:git\s+clone\s+)?(?:https?:\/\/)?(?:github\.com|gitlab\.com)\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\s|$)/i);
    if (bareRepo?.[1] && !seen.has(bareRepo[1])) {
      const fullName = bareRepo[1];
      const host = text.includes("gitlab") ? "gitlab" : "github";
      repos.push({
        url: `https://${host}.com/${fullName}`,
        host,
        fullName,
        needsClone: REPO_MODIFY_RE.test(text),
      });
    }

    return repos;
  }

  // ---- File path detection -----------------------------------------------

  private detectFilePaths(text: string, attachments: ParsedAttachment[]): DetectedFilePath[] {
    const paths: DetectedFilePath[] = [];
    const seen = new Set<string>();

    // Strip URLs first — "https://example.com/file.json" is NOT a local path.
    const noUrls = text.replace(URL_RE, " ");

    // 1. Quoted paths (may contain spaces).
    for (const match of noUrls.matchAll(QUOTED_PATH_RE)) {
      const p = (match[1] ?? match[2] ?? "").trim();
      if (p && looksLikePath(p) && !seen.has(p)) {
        seen.add(p);
        paths.push({ path: p, kind: pathKind(p), isImage: IMAGE_EXT_RE.test(p) });
      }
    }

    // 2. Windows absolute paths.
    for (const match of noUrls.matchAll(WINDOWS_PATH_RE)) {
      const p = match[0]!.replace(/[.,;:!?)\]']+$/, "");
      if (p && !seen.has(p) && !paths.some((x) => p.startsWith(x.path))) {
        seen.add(p);
        paths.push({ path: p, kind: pathKind(p), isImage: IMAGE_EXT_RE.test(p) });
      }
    }

    // 3. Unix absolute paths (require at least 2 segments to avoid false positives).
    for (const match of noUrls.matchAll(UNIX_PATH_RE)) {
      const p = match[0]!.replace(/[.,;:!?)\]']+$/, "");
      if (p && p.length > 3 && !seen.has(p) && !paths.some((x) => p.startsWith(x.path))) {
        seen.add(p);
        paths.push({ path: p, kind: pathKind(p), isImage: IMAGE_EXT_RE.test(p) });
      }
    }

    // 4. Relative paths (./path, ../path, src/index.ts, lib/utils.ts).
    for (const match of noUrls.matchAll(RELATIVE_PATH_RE)) {
      const p = match[0]!.replace(/[.,;:!?)\]']+$/, "");
      if (p && !seen.has(p)) {
        seen.add(p);
        paths.push({ path: p, kind: pathKind(p), isImage: IMAGE_EXT_RE.test(p) });
      }
    }

    // 4b. Well-known single-file names (package.json, tsconfig.json, etc.).
    for (const match of noUrls.matchAll(KNOWN_FILE_RE)) {
      const p = match[0]!;
      if (p && !seen.has(p)) {
        seen.add(p);
        paths.push({ path: p, kind: "file", isImage: false });
      }
    }

    // 5. Image attachments that reference a path in their name.
    for (const att of attachments) {
      if (att.kind === "image" && att.name && looksLikePath(att.name) && !seen.has(att.name)) {
        seen.add(att.name);
        paths.push({ path: att.name, kind: "file", isImage: true });
      }
    }

    return paths;
  }

  // ---- Search intent detection -------------------------------------------

  private detectSearchIntent(text: string): SearchIntent | null {
    let best: { query: string; confidence: number; reason: string } | null = null;

    for (const { re, weight, reason } of SEARCH_PATTERNS) {
      if (re.test(text)) {
        if (!best || weight > best.confidence) {
          best = { query: text, confidence: weight, reason };
        }
      }
    }

    // Suppress search when the request is clearly about a local file or image.
    if (best && best.confidence < 0.8) {
      const hasStrongLocal = IMAGE_EXT_RE.test(text) || WINDOWS_PATH_RE.test(text);
      if (hasStrongLocal) return null;
    }

    return best;
  }

  // ---- Command intent detection ------------------------------------------

  private detectCommandIntent(text: string): CommandIntent | null {
    let best: { command: string; confidence: number } | null = null;

    for (const { re, weight } of COMMAND_PATTERNS) {
      const match = text.match(re);
      if (match) {
        if (!best || weight > best.confidence) {
          best = { command: match[0], confidence: weight };
        }
      }
    }

    return best;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyAttachmentKind(name?: string, mimeType?: string): ParsedAttachment["kind"] {
  if (mimeType) {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType === "application/pdf") return "pdf";
  }
  if (name) {
    if (IMAGE_EXT_RE.test(name)) return "image";
    if (/\.(?:mp3|wav|flac|ogg|aac|m4a|opus)$/i.test(name)) return "audio";
    if (/\.(?:mp4|mov|avi|mkv|webm)$/i.test(name)) return "video";
    if (/\.pdf$/i.test(name)) return "pdf";
  }
  return "unknown";
}

function parseRepoUrl(url: string, text: string): DetectedRepository | null {
  const gh = url.match(GITHUB_REPO_RE);
  if (gh) {
    const fullName = `${gh[1]}/${gh[2]}`;
    return { url: `https://github.com/${fullName}`, host: "github", fullName, needsClone: REPO_MODIFY_RE.test(text) };
  }
  const gl = url.match(GITLAB_REPO_RE);
  if (gl) {
    const fullName = `${gl[1]}/${gl[2]}`;
    return { url: `https://gitlab.com/${fullName}`, host: "gitlab", fullName, needsClone: REPO_MODIFY_RE.test(text) };
  }
  const bb = url.match(BITBUCKET_REPO_RE);
  if (bb) {
    const fullName = `${bb[1]}/${bb[2]}`;
    return { url: `https://bitbucket.org/${fullName}`, host: "bitbucket", fullName, needsClone: REPO_MODIFY_RE.test(text) };
  }
  return null;
}

function looksLikePath(s: string): boolean {
  return (
    /^[A-Za-z]:[\\\/]/.test(s) ||
    s.startsWith("/") ||
    s.startsWith("./") || s.startsWith("../") || s.startsWith("~/") ||
    s.startsWith(".\\") || s.startsWith("..\\") ||
    /\.[A-Za-z0-9]{1,10}$/.test(s) // has a file extension
  );
}

function pathKind(p: string): "file" | "dir" {
  if (/[\\\/]$/.test(p)) return "dir";
  if (TEXT_FILE_EXT_RE.test(p) || IMAGE_EXT_RE.test(p)) return "file";
  // No extension and no trailing slash — ambiguous, default to file.
  return /\.[A-Za-z0-9]{1,10}$/.test(p) ? "file" : "dir";
}
