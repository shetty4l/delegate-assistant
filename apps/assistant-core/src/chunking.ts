/**
 * Markdown-aware message chunking for Telegram's 4096-char limit.
 *
 * Splits text into chunks that each fit within maxLength, preserving
 * markdown structure (paragraphs, code fences). Code blocks are
 * closed/reopened at chunk boundaries so each chunk is valid markdown.
 */

const DEFAULT_MAX_LENGTH = 4096;

/**
 * Reserve space for the part indicator suffix " (1/10)" etc.
 * Worst case: " (XX/XX)" = 8 chars. We reserve 10 for safety.
 */
const PART_INDICATOR_RESERVE = 10;

/**
 * Split text into chunks that each fit within maxLength characters.
 *
 * Splitting priority (highest to lowest):
 * 1. Paragraph boundary (double newline)
 * 2. Line boundary (single newline) — never inside a code fence mid-line
 * 3. Hard cut at maxLength (last resort)
 *
 * Code fences (```) are tracked. If a chunk ends inside a code block,
 * the fence is closed at the end of that chunk and reopened (with the
 * original language tag) at the start of the next chunk.
 */
export const splitMessage = (
  text: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): string[] => {
  if (text.length <= maxLength) {
    return [text];
  }

  const effectiveMax = maxLength - PART_INDICATOR_RESERVE;
  const chunks: string[] = [];
  let remaining = text;

  // Track whether we're inside a code fence and its language tag.
  let inCodeBlock = false;
  let codeLang = "";

  while (remaining.length > 0) {
    // If remaining fits in one chunk, push it and done.
    if (remaining.length <= effectiveMax) {
      chunks.push(remaining);
      break;
    }

    // We need to split. Find the best split point within effectiveMax.
    const window = remaining.slice(0, effectiveMax);

    // Determine the code-fence state within this window so we know
    // if the split lands inside a code block.
    const { splitIndex, insideFence, lang } = findSplitPoint(
      window,
      effectiveMax,
      inCodeBlock,
      codeLang,
    );

    let chunk = remaining.slice(0, splitIndex);
    remaining = remaining.slice(splitIndex);

    // Trim leading newlines from remaining (avoid empty-looking starts).
    const trimmed = remaining.replace(/^\n{1,2}/, "");
    remaining = trimmed;

    // If we ended inside a code fence, close it in this chunk and
    // reopen in the next.
    if (insideFence) {
      chunk = `${chunk}\n\`\`\``;
      remaining = `\`\`\`${lang ? lang : ""}\n${remaining}`;
      inCodeBlock = true;
      codeLang = lang;
    } else {
      inCodeBlock = false;
      codeLang = "";
    }

    if (chunk.trim().length > 0) {
      chunks.push(chunk);
    }
  }

  return chunks;
};

/**
 * Find the best split point within the window text.
 *
 * Returns the character index to split at (exclusive), whether the split
 * lands inside a code fence, and the fence's language tag if so.
 */
const findSplitPoint = (
  window: string,
  maxLength: number,
  enteredInFence: boolean,
  enteredLang: string,
): { splitIndex: number; insideFence: boolean; lang: string } => {
  // Track code fence state as we scan.
  let inFence = enteredInFence;

  // Scan for code fences to know the state at any position.
  // We collect fence toggle positions so we can determine state at split point.
  const fenceToggles: Array<{
    index: number;
    opens: boolean;
    lang: string;
  }> = [];

  const fenceRegex = /^(`{3,})(.*)?$/gm;
  let match: RegExpExecArray | null = null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((match = fenceRegex.exec(window)) !== null) {
    if (inFence) {
      // This closes the fence.
      fenceToggles.push({ index: match.index, opens: false, lang: "" });
      inFence = false;
    } else {
      // This opens a fence.
      const fenceLang = (match[2] ?? "").trim();
      fenceToggles.push({
        index: match.index,
        opens: true,
        lang: fenceLang,
      });
      inFence = true;
    }
  }

  // Now determine the fence state at various candidate split points.
  const fenceStateAt = (
    pos: number,
  ): { insideFence: boolean; lang: string } => {
    let state = enteredInFence;
    let currentLang = enteredLang;
    for (const toggle of fenceToggles) {
      if (toggle.index >= pos) {
        break;
      }
      if (toggle.opens) {
        state = true;
        currentLang = toggle.lang;
      } else {
        state = false;
        currentLang = "";
      }
    }
    return { insideFence: state, lang: currentLang };
  };

  // Priority 1: Try to split on a paragraph boundary (\n\n).
  // Search backwards from the end of the window for the last \n\n.
  const lastParaBreak = window.lastIndexOf("\n\n");
  if (lastParaBreak > 0) {
    // Split after the double newline.
    const splitAt = lastParaBreak;
    const state = fenceStateAt(splitAt);
    // Only use paragraph boundary if we're not splitting inside a code block,
    // or if there's no better option.
    if (!state.insideFence) {
      return { splitIndex: splitAt, ...state };
    }
  }

  // Priority 2: Try to split on a line boundary (\n).
  const lastLineBreak = window.lastIndexOf("\n");
  if (lastLineBreak > 0) {
    const splitAt = lastLineBreak;
    const state = fenceStateAt(splitAt);
    return { splitIndex: splitAt, ...state };
  }

  // Priority 3: Hard cut at maxLength.
  const state = fenceStateAt(maxLength);
  return { splitIndex: maxLength, ...state };
};

/**
 * Add part indicators to chunks: " (1/3)", " (2/3)", etc.
 * Also appends the cost footer to the last chunk if provided.
 */
export const addChunkMetadata = (
  chunks: string[],
  costFooter?: string,
): string[] => {
  if (chunks.length === 0) {
    return chunks;
  }

  // Single chunk: just append footer if present.
  if (chunks.length === 1) {
    const footer = costFooter ?? "";
    return [chunks[0] + footer];
  }

  const total = chunks.length;
  return chunks.map((chunk, i) => {
    const indicator = ` (${String(i + 1)}/${String(total)})`;
    const footer = i === total - 1 && costFooter ? costFooter : "";
    return chunk + footer + indicator;
  });
};
