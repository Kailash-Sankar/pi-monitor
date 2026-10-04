/**
 * Line splitting for streamed process output.
 *
 * Kept pure and separate so the tricky parts — multi-byte characters split
 * across chunks, CRLF endings, and oversized newline-free output — are testable
 * without spawning anything.
 */

import { StringDecoder } from "node:string_decoder";

export interface LineReader {
  /** Feed a chunk of bytes. Emits every complete line it can. */
  write(chunk: Buffer): void;
  /** Emit any buffered trailing fragment. Call once at stream end. */
  flush(): void;
}

const DEFAULT_MAX_LINE_LENGTH = 64 * 1024;

/**
 * @param onLine Called for each line, without the trailing newline or `\r`.
 * @param maxLineLength If a fragment exceeds this with no newline (e.g. a `\r`
 *   progress bar), it is emitted as-is and the buffer is cleared, bounding
 *   memory.
 */
export function createLineReader(
  onLine: (line: string) => void,
  maxLineLength: number = DEFAULT_MAX_LINE_LENGTH,
): LineReader {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const emit = (raw: string): void => {
    onLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
  };

  return {
    write(chunk: Buffer): void {
      buffer += decoder.write(chunk);
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        emit(line);
        idx = buffer.indexOf("\n");
      }
      if (buffer.length > maxLineLength) {
        emit(buffer);
        buffer = "";
      }
    },
    flush(): void {
      buffer += decoder.end();
      if (buffer.length > 0) {
        emit(buffer);
        buffer = "";
      }
    },
  };
}
