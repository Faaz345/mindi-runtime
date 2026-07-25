/**
 * Terminal Input Architecture
 *
 * A decoupled input component that:
 *   - Supports multiline editing (Enter sends, Shift+Enter newline)
 *   - Handles pasted code (multi-paste detection)
 *   - Keyboard shortcuts (Ctrl+C interrupt, Ctrl+D exit, Ctrl+L clear)
 *   - Slash commands (/help, /providers, /models, etc.)
 *   - Prompt history (Up/Down arrows)
 *   - Streaming interruption (Ctrl+C during generation)
 *   - Attachments (files, images)
 *   - Is completely independent from the provider system
 *
 * The component is framework-agnostic — it exposes a controller
 * interface that any UI (Ink terminal, Electron desktop, web) can use.
 * The Ink-specific rendering lives in a separate component.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An attachment (file or image). */
export interface InputAttachment {
  name: string;
  mimeType: string;
  data: string; // base64 for images, text for code files
  isImage: boolean;
}

/** Input state. */
export interface InputState {
  text: string;
  cursorPosition: number;
  attachments: InputAttachment[];
  isStreaming: boolean;
  mode: "chat" | "command";
}

/** Input event — emitted on every state change. */
export type InputEvent =
  | { type: "text"; text: string; cursor: number }
  | { type: "submit"; text: string; attachments: InputAttachment[]; isCommand: boolean }
  | { type: "interrupt" }
  | { type: "exit" }
  | { type: "clear" }
  | { type: "history-up" }
  | { type: "history-down" }
  | { type: "attachment-added"; attachment: InputAttachment }
  | { type: "attachment-removed"; index: number }
  | { type: "mode-changed"; mode: "chat" | "command" };

// ---------------------------------------------------------------------------
// Input Controller
// ---------------------------------------------------------------------------

/**
 * InputController — framework-agnostic input state machine.
 *
 * Manages:
 *   - Text buffer with cursor position
 *   - Multiline support
 *   - Prompt history
 *   - Slash command detection
 *   - Attachment list
 *   - Submit/interrupt/clear events
 *
 * The UI layer (Ink component, React component, etc.) calls `handleKey()`
 * for each keystroke and `handlePaste()` for paste events, then renders
 * the state from `getState()`.
 *
 * This component is completely independent from the provider system.
 * It can be reused in the desktop application without modification.
 */
export class InputController {
  private state: InputState;
  private history: string[] = [];
  private historyIdx: number = -1;
  private draftBeforeHistory: string = "";
  private readonly listeners = new Set<(event: InputEvent) => void>();
  private readonly maxHistory: number;

  constructor(opts: { maxHistory?: number } = {}) {
    this.maxHistory = opts.maxHistory ?? 100;
    this.state = {
      text: "",
      cursorPosition: 0,
      attachments: [],
      isStreaming: false,
      mode: "chat",
    };
  }

  // ---- State Access ----------------------------------------------------

  getState(): Readonly<InputState> {
    return { ...this.state };
  }

  /** Whether the input is in command mode (starts with / or :). */
  isCommandMode(): boolean {
    return this.state.text.startsWith("/") || this.state.text.startsWith(":");
  }

  // ---- Event Subscription ----------------------------------------------

  subscribe(listener: (event: InputEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: InputEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* ignore listener errors */ }
    }
  }

  // ---- Key Handling ----------------------------------------------------

  /**
   * Handle a keystroke. Returns true if the key was consumed.
   *
   * Key format (framework-agnostic):
   *   { key: string; ctrl?: boolean; shift?: boolean; meta?: boolean }
   *
   * Special keys: "return", "backspace", "delete", "up", "down",
   * "left", "right", "escape", "tab"
   */
  handleKey(key: {
    key: string;
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
  }): boolean {
    const { key: k, ctrl, shift } = key;

    // Ctrl+C: interrupt if streaming, exit if not.
    if (ctrl && k === "c") {
      if (this.state.isStreaming) {
        this.emit({ type: "interrupt" });
      } else {
        this.emit({ type: "exit" });
      }
      return true;
    }

    // Ctrl+D: exit.
    if (ctrl && k === "d") {
      this.emit({ type: "exit" });
      return true;
    }

    // Ctrl+L: clear.
    if (ctrl && k === "l") {
      this.emit({ type: "clear" });
      return true;
    }

    // Return: submit (unless Shift+Enter for multiline).
    if (k === "return" && !shift) {
      this.submit();
      return true;
    }

    // Shift+Enter or just Enter on empty multiline: insert newline.
    if (k === "return" && shift) {
      this.insertChar("\n");
      return true;
    }

    // Up arrow: history navigation (if on first line) or cursor up.
    if (k === "up") {
      if (this.isOnFirstLine()) {
        this.emit({ type: "history-up" });
        this.navigateHistory(-1);
        return true;
      }
      // Otherwise let the UI move the cursor.
      return false;
    }

    // Down arrow: history navigation (if on last line).
    if (k === "down") {
      if (this.isOnLastLine()) {
        this.emit({ type: "history-down" });
        this.navigateHistory(1);
        return true;
      }
      return false;
    }

    // Backspace.
    if (k === "backspace" || k === "delete") {
      this.deleteBackward();
      return true;
    }

    // Escape: clear attachments or reset.
    if (k === "escape") {
      if (this.state.attachments.length > 0) {
        this.state.attachments = [];
        this.emit({ type: "text", text: this.state.text, cursor: this.state.cursorPosition });
      }
      return true;
    }

    // Regular character.
    if (k.length === 1 && !ctrl && !key.meta) {
      this.insertChar(k);
      return true;
    }

    return false;
  }

  /** Handle a paste event (multi-line text). */
  handlePaste(text: string): void {
    this.insertAtCursor(text);
  }

  /** Add an attachment. */
  addAttachment(attachment: InputAttachment): void {
    this.state.attachments.push(attachment);
    this.emit({ type: "attachment-added", attachment });
  }

  /** Remove an attachment by index. */
  removeAttachment(index: number): void {
    this.state.attachments.splice(index, 1);
    this.emit({ type: "attachment-removed", index });
  }

  /** Set streaming state. */
  setStreaming(streaming: boolean): void {
    this.state.isStreaming = streaming;
  }

  /** Clear the input. */
  clear(): void {
    this.state.text = "";
    this.state.cursorPosition = 0;
    this.state.attachments = [];
    this.historyIdx = -1;
    this.emit({ type: "text", text: "", cursor: 0 });
  }

  // ---- Internal: Text Manipulation -------------------------------------

  private insertChar(ch: string): void {
    const before = this.state.text.slice(0, this.state.cursorPosition);
    const after = this.state.text.slice(this.state.cursorPosition);
    this.state.text = before + ch + after;
    this.state.cursorPosition += ch.length;
    this.updateMode();
    this.emit({ type: "text", text: this.state.text, cursor: this.state.cursorPosition });
  }

  private insertAtCursor(text: string): void {
    const before = this.state.text.slice(0, this.state.cursorPosition);
    const after = this.state.text.slice(this.state.cursorPosition);
    this.state.text = before + text + after;
    this.state.cursorPosition += text.length;
    this.updateMode();
    this.emit({ type: "text", text: this.state.text, cursor: this.state.cursorPosition });
  }

  private deleteBackward(): void {
    if (this.state.cursorPosition === 0) return;
    const before = this.state.text.slice(0, this.state.cursorPosition - 1);
    const after = this.state.text.slice(this.state.cursorPosition);
    this.state.text = before + after;
    this.state.cursorPosition--;
    this.updateMode();
    this.emit({ type: "text", text: this.state.text, cursor: this.state.cursorPosition });
  }

  private submit(): void {
    const text = this.state.text.trim();
    if (!text) return;

    // Add to history.
    if (text && (this.history.length === 0 || this.history[this.history.length - 1] !== text)) {
      this.history.push(text);
      if (this.history.length > this.maxHistory) this.history.shift();
    }
    this.historyIdx = -1;
    this.draftBeforeHistory = "";

    const isCommand = text.startsWith("/") || text.startsWith(":");
    this.emit({
      type: "submit",
      text,
      attachments: [...this.state.attachments],
      isCommand,
    });

    // Clear input after submit.
    this.state.text = "";
    this.state.cursorPosition = 0;
    this.state.attachments = [];
    this.emit({ type: "text", text: "", cursor: 0 });
  }

  private updateMode(): void {
    const newMode: "chat" | "command" = this.isCommandMode() ? "command" : "chat";
    if (newMode !== this.state.mode) {
      this.state.mode = newMode;
      this.emit({ type: "mode-changed", mode: newMode });
    }
  }

  // ---- Internal: History -----------------------------------------------

  private navigateHistory(direction: 1 | -1): void {
    if (this.history.length === 0) return;

    if (this.historyIdx === -1) {
      // Save current draft before navigating.
      this.draftBeforeHistory = this.state.text;
    }

    let newIdx: number;
    if (direction === -1) {
      // Up: go to previous (older) entry.
      newIdx = this.historyIdx < 0
        ? this.history.length - 1
        : Math.max(0, this.historyIdx - 1);
    } else {
      // Down: go to next (newer) entry.
      newIdx = this.historyIdx + 1;
      if (newIdx >= this.history.length) {
        // Restore draft.
        this.historyIdx = -1;
        this.state.text = this.draftBeforeHistory;
        this.state.cursorPosition = this.state.text.length;
        this.emit({ type: "text", text: this.state.text, cursor: this.state.cursorPosition });
        return;
      }
    }

    this.historyIdx = newIdx;
    this.state.text = this.history[newIdx] ?? "";
    this.state.cursorPosition = this.state.text.length;
    this.updateMode();
    this.emit({ type: "text", text: this.state.text, cursor: this.state.cursorPosition });
  }

  // ---- Internal: Cursor Helpers ----------------------------------------

  private isOnFirstLine(): boolean {
    const before = this.state.text.slice(0, this.state.cursorPosition);
    return !before.includes("\n");
  }

  private isOnLastLine(): boolean {
    const after = this.state.text.slice(this.state.cursorPosition);
    return !after.includes("\n");
  }

  // ---- Public: History Access ------------------------------------------

  getHistory(): readonly string[] {
    return this.history;
  }
}
