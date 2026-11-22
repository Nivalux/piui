/// <reference lib="dom" />
/**
 * The wire shapes, described once so the reducer, the page and `tsc` read the
 * same thing.
 *
 * Names here follow pi's own protocol documents (`docs/json.md`,
 * `docs/message-types.md`, `docs/rpc-commands.md`) rather than inventing a
 * piui-flavoured middle layer: a field that is called `toolName` upstream is
 * called `toolName` here. `testdata/*.jsonl` holds real records and both the Zig
 * tests and the node tests parse them, which is how a rename upstream gets
 * noticed instead of silently rendering nothing.
 */

/**
 * One block of message content. Pi sends a bare string for a simple message and
 * a list of these as soon as anything else is in there — including base64
 * images, which is why the chat can show pictures without a file endpoint.
 *
 * @typedef {Object} Content
 * @property {"text" | "thinking" | "image" | "toolCall"} type
 * @property {string} [text]
 * @property {string} [thinking]
 * @property {string} [data] base64 payload of an image
 * @property {string} [mimeType]
 * @property {string} [id] tool call id
 * @property {string} [name] tool name
 * @property {Record<string, unknown>} [arguments]
 */

/**
 * @typedef {Object} Usage
 * @property {number} [input]
 * @property {number} [output]
 * @property {number} [cacheRead]
 * @property {number} [cacheWrite]
 * @property {number} [totalTokens]
 * @property {{input?: number, output?: number, cacheRead?: number, cacheWrite?: number, total?: number}} [cost]
 */

/**
 * The nested delta of a `message_update`. On the wire these carry no cumulative
 * message and no `partial` snapshot.
 *
 * @typedef {Object} AssistantEvent
 * @property {"start" | "text_start" | "text_delta" | "text_end" | "thinking_start" | "thinking_delta" | "thinking_end" | "toolcall_start" | "toolcall_delta" | "toolcall_end" | "done" | "error"} type
 * @property {number} [contentIndex]
 * @property {string} [delta]
 * @property {string} [content] authoritative text of the block at `text_end`
 * @property {string} [id]
 * @property {string} [toolName]
 * @property {Content} [toolCall]
 * @property {string} [reason]
 * @property {string} [error]
 */

/**
 * @typedef {Object} Message
 * @property {"user" | "assistant" | "toolResult"} role
 * @property {string | Content[]} [content]
 * @property {Usage} [usage]
 * @property {string} [stopReason]
 * @property {string} [errorMessage]
 * @property {string} [toolCallId]
 * @property {string} [toolName]
 * @property {boolean} [isError]
 * @property {unknown} [details]
 * @property {number | string} [timestamp]
 * @property {number} [durationMs] what the tool says the call took, on the result
 */

/**
 * What `/api/tabs` and the first SSE frame describe.
 *
 * A terminal window the server keeps open: one shell, one folder.
 *
 * @typedef {{id: string, cwd: string, tab: string, closed: boolean, exitCode: number, createdMs: number, lastOutputMs: number}} ShellInfo
 */

/**
 * @typedef {Object} TabInfo
 * @property {string} id
 * @property {string} cwd
 * @property {boolean} project
 * @property {string | null} [sessionPath]
 * @property {string | null} [sessionName]
 * @property {boolean} running
 * @property {boolean} closed
 * @property {number} createdMs
 * @property {number} lastOutputMs
 * @property {number} [runStartedMs]
 * @property {string | null} [copiedFrom]
 * @property {string | null} [goneFolder]
 * @property {number} [finishedMs]
 */

/** piui's own frames, mixed into the same stream so the browser has one socket. */
/**
 * @typedef {{type: "piui", event: "tab", tab: TabInfo} | {type: "piui", event: "running", running: boolean} | {type: "piui", event: "closed", reason: string, stderr?: string}} PiuiEvent
 */

/**
 * A model as pi configures it; only the fields the picker needs.
 *
 * @typedef {Object} PiModel
 * @property {string} id
 * @property {string} [name]
 * @property {string} [provider]
 * @property {boolean} [reasoning]
 */

/**
 * Everything that can arrive on a tab's stream, as one loose record: a
 * reducer looks at `type` and then only at the fields of that branch. The
 * first frame of a stream is a bare `TabInfo` with no `type` at all.
 *
 * @typedef {Object} Frame
 * @property {string} [type]
 * @property {string} [event]
 * @property {string} [id]
 * @property {string} [command]
 * @property {boolean} [success]
 * @property {Record<string, any>} [data]
 * @property {TabInfo} [tab]
 * @property {Message} [message]
 * @property {Message[]} [messages]
 * @property {Usage} [usage]
 * @property {AssistantEvent} [assistantMessageEvent]
 * @property {string | number} [timestamp] live events carry epoch milliseconds, a restored session its ISO stamp
 * @property {string} [toolCallId]
 * @property {string} [toolName]
 * @property {Record<string, unknown>} [args]
 * @property {unknown} [partialResult]
 * @property {number} [durationMs] how long a finished tool says it ran
 * @property {unknown} [result]
 * @property {unknown} [details]
 * @property {boolean} [isError]
 * @property {boolean} [running]
 * @property {boolean} [aborted]
 * @property {boolean} [willRetry]
 * @property {string} [reason]
 * @property {string} [stderr]
 * @property {string} [name]
 * @property {string} [level]
 * @property {number} [attempt]
 * @property {number} [maxAttempts]
 * @property {number} [delayMs]
 * @property {string} [errorMessage]
 * @property {string} [finalError]
 * @property {string} [extensionPath]
 * @property {string} [error]
 * @property {string} [delta]
 * @property {Message[]} [toolResults]
 * @property {Message[]} [steering]
 * @property {Message[]} [followUp]
 * @property {number} [code] exit code of a shell that closed
 */

/** @typedef {{name: string, description?: string, argumentHint?: string, source?: string}} Command */

/**
 * @typedef {Object} Ui
 * @property {string} [theme]
 * @property {boolean} [sidebar]
 * @property {boolean} [files]
 * @property {number} [sidebar_width]
 * @property {number} [files_width]
 * @property {boolean} [show_thinking]
 * @property {boolean} [send_on_enter]
 * @property {"steer" | "queue"} [send_mode]
 */

/**
 * Decode one SSE `data:` payload. Anything that is not a JSON object is dropped
 * by the caller rather than killing the stream.
 *
 * @param {string} text
 * @returns {Frame | null}
 */
export function parseFrame(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    const value = /** @type {unknown} */ (JSON.parse(trimmed));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return /** @type {Frame} */ (value);
  } catch {
    return null;
  }
}

/**
 * @param {Frame} frame
 * @returns {frame is PiuiEvent}
 */
export function isPiuiEvent(frame) {
  return frame.type === "piui";
}

/**
 * Content as a block list.
 *
 * @param {string | Content[] | undefined} content
 * @returns {Content[]}
 */
export function blocks(content) {
  if (content === undefined) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

/**
 * The text of a message, thinking excluded.
 *
 * @param {string | Content[] | undefined} content
 * @returns {string}
 */
export function textOf(content) {
  return blocks(content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => /** @type {string} */ (block.text))
    .join("\n");
}

/**
 * The blocks behind whatever a tool handed back: a bare string, a list of
 * blocks, or an object carrying them under `content`.
 *
 * @param {unknown} value
 * @returns {Content[]}
 */
export function resultBlocks(value) {
  if (typeof value === "string") return blocks(value);
  if (Array.isArray(value)) return /** @type {Content[]} */ (value);
  if (value && typeof value === "object") {
    const content = /** @type {{content?: unknown}} */ (value).content;
    if (content !== undefined) return resultBlocks(content);
  }
  return [];
}

/**
 * @param {unknown} content a message's content, or whatever a tool returned
 * @returns {Content[]}
 */
export function imagesOf(content) {
  return resultBlocks(content).filter((block) => block.type === "image" && typeof block.data === "string");
}

/**
 * `data:` URL for a base64 image block, with the mime type pi reported.
 *
 * @param {{mimeType?: string, data?: string}} block
 * @returns {string}
 */
export function imageDataUrl(block) {
  return `data:${block.mimeType ?? "image/png"};base64,${block.data ?? ""}`;
}

/**
 * Tool results and messages both carry their text in blocks, and a tool may
 * return a bare string.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function flattenResult(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const content = /** @type {{content?: unknown}} */ (value).content;
    if (content !== undefined) return flattenResult(content);
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        const block = /** @type {Content} */ (part);
        if (block?.type === "text") return block.text ?? "";
        if (block?.type === "image") return "";
        return JSON.stringify(part);
      })
      .filter((part) => part.length > 0)
      .join("\n");
  }
  return value === null || value === undefined ? "" : JSON.stringify(value);
}
