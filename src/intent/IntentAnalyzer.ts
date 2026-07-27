import type {
  CapabilityType,
  ChatMessage,
  IntentDescriptor,
  IntentSignal,
} from "../core/types.js";
import { CapabilityType as Cap } from "../core/types.js";

/**
 * IntentAnalyzer
 *
 * Inspects the user's request (input text + attachments) and decides which
 * capabilities the request appears to require. Pure heuristic / regex-based
 * in the base implementation — no LLM call (we don't want to spend tokens
 * deciding whether to spend tokens).
 *
 * Subclasses can override `analyze()` to swap in an LLM-backed analyzer
 * without touching the rest of the pipeline.
 */
export class IntentAnalyzer {
  /**
   * Keyword/pattern table. Each entry contributes a weighted signal toward
   * a capability. A capability is required when the summed weight crosses
   * the threshold.
   */
  private readonly rules: Array<{
    capability: CapabilityType;
    pattern: RegExp;
    weight: number;
    reason: string;
  }> = [
    // Vision / image understanding
    { capability: Cap.Vision, pattern: /\bimage|picture|photo|screenshot|see this|look at|what('?s| is) in (this|the) (image|pic|photo)|describe (this|the) (image|photo|picture)|attached (image|photo|picture)|read (this|the) (chart|graph|diagram)\b/i, weight: 0.9, reason: "mentions image/photo/screenshot" },
    { capability: Cap.Vision, pattern: /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i, weight: 0.85, reason: "image file extension" },
    { capability: Cap.Vision, pattern: /screencapture|screen[-_ ]?shot|capture/i, weight: 0.9, reason: "screenshot/screencapture in path" },
    { capability: Cap.Vision, pattern: /[A-Z]:\\[^\s"']+\.(png|jpe?g|gif|webp|bmp)/i, weight: 0.85, reason: "image file path (Windows)" },
    { capability: Cap.Vision, pattern: /"[^"]+\.(png|jpe?g|gif|webp|bmp|tiff?)"/i, weight: 0.9, reason: "quoted image path (may contain spaces)" },
    { capability: Cap.Vision, pattern: /'[^']+\.(png|jpe?g|gif|webp|bmp|tiff?)'/i, weight: 0.9, reason: "quoted image path (may contain spaces)" },
    { capability: Cap.Vision, pattern: /\/[^\s"']+\.(png|jpe?g|gif|webp|bmp)/i, weight: 0.85, reason: "image file path (Unix)" },
    { capability: Cap.Vision, pattern: /\b(analyze|analyse|review|inspect|describe)\s+(this\s+)?(image|screenshot|picture|photo|capture|screencapture)/i, weight: 0.9, reason: "analyze image/screenshot request" },
    // OCR — text extraction from images / scans
    { capability: Cap.OCR, pattern: /\bocr|extract text from|scan(ned)?|handwriting|read text in (this|the) (image|scan|photo)|transcribe (this|the) (image|scan|document)\b/i, weight: 0.9, reason: "OCR/extraction language" },
    { capability: Cap.OCR, pattern: /\.pdf$/i, weight: 0.6, reason: "PDF often needs OCR" },
    // Web search
    { capability: Cap.WebSearch, pattern: /\b(search|google|look up|find (out|info|information)|latest|current|news|today|recent|now|who (is|are)|what('?s| is)|when (did|was)|how (do|does|to)|where (is|are))\b/i, weight: 0.5, reason: "search/current-events language" },
    { capability: Cap.WebSearch, pattern: /\b(real[- ]?time|up[- ]?to[- ]?date|as of|happening now|breaking|stock price|weather|score)\b/i, weight: 0.8, reason: "real-time/freshness language" },
    // Browser automation
    { capability: Cap.Browser, pattern: /\b(open (this|the) (page|site|website|url|link)|navigate|browse|click (on|the)|scrape|crawl|page source|dom|webpage|web page|fill (in|out) (the )?form)\b/i, weight: 0.85, reason: "browser/navigation language" },
    { capability: Cap.Browser, pattern: /^https?:\/\//i, weight: 0.7, reason: "URL in input" },
    // Filesystem
    { capability: Cap.Filesystem, pattern: /\b(read|open|write|create|edit|delete|move|list) (the )?(file|folder|directory|path|files|dirs)\b/i, weight: 0.8, reason: "filesystem operation" },
    { capability: Cap.Filesystem, pattern: /\.(txt|md|json|ya?ml|csv|tsv|xml|html?|css|js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|rb|php|sh|sql|log|ini|toml|env)\b/i, weight: 0.6, reason: "text file extension" },
    { capability: Cap.Filesystem, pattern: /\b(in|under|at|from) (this )?(dir|directory|folder|path|repo|workspace|project)\b/i, weight: 0.5, reason: "path reference" },
    // Git
    { capability: Cap.Git, pattern: /\bgit (status|log|diff|commit|push|pull|branch|checkout|merge|rebase|stash|blame|show|add|reset|revert|tag|cherry)\b/i, weight: 0.95, reason: "git subcommand" },
    { capability: Cap.Git, pattern: /\b(commit|branch|merge conflict|pull request|pr|repo|repository|unstaged|staged|working tree)\b/i, weight: 0.6, reason: "git terminology" },
    // Terminal
    { capability: Cap.Terminal, pattern: /\brun (this )?(command|cmd|shell|script)|execute|terminal|bash|powershell|cmd\b/i, weight: 0.85, reason: "shell command" },
    { capability: Cap.Terminal, pattern: /\$\s|^>\s/i, weight: 0.7, reason: "shell prompt prefix" },
    { capability: Cap.Terminal, pattern: /\b(npm|pnpm|yarn|node|python|pip|cargo|go|make|docker|kubectl|curl|wget|ssh|grep|find|ls|cat|echo)\b/i, weight: 0.55, reason: "common CLI tool" },
    // Image generation
    { capability: Cap.ImageGeneration, pattern: /\b(generate|create|make|draw|paint|design|render) (an? )?(image|picture|photo|illustration|drawing|painting|logo|icon|thumbnail|banner|wallpaper|art|render)\b/i, weight: 0.9, reason: "image generation request" },
    { capability: Cap.ImageGeneration, pattern: /\bdall[- ]?e|midjourney|stable diffusion|sdxl|image gen\b/i, weight: 0.85, reason: "image-gen tool name" },
    // Audio
    { capability: Cap.Audio, pattern: /\.(mp3|wav|flac|ogg|aac|m4a|opus|webm)\b/i, weight: 0.85, reason: "audio file extension" },
    { capability: Cap.Audio, pattern: /\b(transcribe|transcription|whisper|speech to text|s2t|speech-to-text|audio|voice (recording|memo|clip))\b/i, weight: 0.8, reason: "audio/transcription language" },
    // Embeddings
    { capability: Cap.Embeddings, pattern: /\b(embedding|embed|vector(ize| representation)?|semantic search|similarity|cluster(ing)?)\b/i, weight: 0.8, reason: "embedding language" },
    // Database
    { capability: Cap.Database, pattern: /\b(query|sql|select .+ from|database|postgres|mysql|sqlite|mongo|redis|dynamodb|table|schema)\b/i, weight: 0.75, reason: "database language" },
  ];

  private readonly threshold = 0.5;

  /**
   * Analyze a request. Returns an IntentDescriptor.
   * `attachments` may carry file names / MIME types that hint at capabilities.
   */
  analyze(input: string, attachments: Array<{ name?: string; mimeType?: string }> = [], _messages: ChatMessage[] = []): IntentDescriptor {
    const signals: IntentSignal[] = [];
    // Combine the latest user input + any attachment names into the scan corpus.
    const corpus = [
      input,
      ...attachments.map((a) => `${a.name ?? ""} ${a.mimeType ?? ""}`),
    ].join("\n");

    // Dedupe by capability — take the max weight per capability.
    const byCap = new Map<CapabilityType, IntentSignal>();
    for (const rule of this.rules) {
      if (rule.pattern.test(corpus)) {
        const existing = byCap.get(rule.capability);
        if (!existing || rule.weight > existing.weight) {
          byCap.set(rule.capability, {
            capability: rule.capability,
            reason: rule.reason,
            weight: rule.weight,
          });
        }
      }
    }

    // Suppress weak web-search signals when a strong vision signal is present.
    // "What's in this image?" is a vision question about a local file — not a
    // web search. Without this, the bare question words ("whats", "what is")
    // trigger a useless web search for the file path string.
    const visionSignal = byCap.get(Cap.Vision);
    const searchSignal = byCap.get(Cap.WebSearch);
    if (visionSignal && visionSignal.weight >= 0.8 && searchSignal && searchSignal.weight <= 0.5) {
      byCap.delete(Cap.WebSearch);
    }

    const requiredCapabilities = Array.from(byCap.values())
      .filter((s) => s.weight >= this.threshold)
      .sort((a, b) => b.weight - a.weight)
      .map((s) => {
        signals.push(s);
        return s.capability;
      });

    // Chat capability is ALWAYS required — every request needs the reasoning engine.
    if (!requiredCapabilities.includes(Cap.Chat)) {
      requiredCapabilities.push(Cap.Chat);
      signals.push({ capability: Cap.Chat, reason: "primary reasoning", weight: 1 });
    }

    const confidence = signals.length === 0
      ? 0.3
      : Math.min(1, signals.reduce((s, x) => s + x.weight, 0) / Math.max(signals.length, 1));

    return {
      summary: summarize(input),
      requiredCapabilities,
      confidence,
      signals,
    };
  }
}

function summarize(input: string): string {
  const trimmed = input.trim().replace(/\s+/g, " ");
  return trimmed.length > 140 ? trimmed.slice(0, 137) + "..." : trimmed;
}
