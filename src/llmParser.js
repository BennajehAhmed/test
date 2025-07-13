/**
 * @typedef {({type: 'text', content: string} | {type: 'file', path: string, content: string})} ParsedPart
 */

/**
 * Parses the raw LLM response string into structured parts.
 * The response can contain plain text and special <file> tags.
 * @param {string} rawResponse The raw string from the LLM.
 * @returns {ParsedPart[]} An array of parsed parts.
 */
function parseLLMResponse(rawResponse) {
  const parts = [];
  const fileBlockRegex = /<file path="([^"]+)">([\s\S]*?)<\/file>/g;
  let lastIndex = 0;
  let match;

  while ((match = fileBlockRegex.exec(rawResponse)) !== null) {
    if (match.index > lastIndex) {
      const textContent = rawResponse.substring(lastIndex, match.index).trim();
      if (textContent) {
        parts.push({ type: "text", content: textContent });
      }
    }

    const [_, path, content] = match;
    parts.push({ type: "file", path, content: content.trim() });
    lastIndex = fileBlockRegex.lastIndex;
  }

  if (lastIndex < rawResponse.length) {
    const textContent = rawResponse.substring(lastIndex).trim();
    if (textContent) {
      parts.push({ type: "text", content: textContent });
    }
  }

  if (parts.length === 0 && rawResponse.trim()) {
    parts.push({ type: "text", content: rawResponse });
  }

  return parts;
}

module.exports = {
  parseLLMResponse,
};
