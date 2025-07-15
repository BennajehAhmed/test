// src/toolParser.js
const readFileRegex = /<readFile\s+path="([^"]+)"\s*\/>/g;
const writeFileRegex =
  /<writeFile\s+path="([^"]+)"\s*>([\s\S]*?)<\/writeFile>/g;
const runCommandRegex = /<runCommand>([\s\S]*?)<\/runCommand>/g;

/**
 * Returns {toolCalls, cleanText}
 *   toolCalls: array of {type, path?, content?, command?}
 *   cleanText: original text with tool tags stripped (for history)
 */
function extractTools(raw) {
  const toolCalls = [];

  // readFile
  let m;
  while ((m = readFileRegex.exec(raw)) !== null) {
    toolCalls.push({ type: "readFile", path: m[1] });
  }

  // writeFile
  writeFileRegex.lastIndex = 0;
  while ((m = writeFileRegex.exec(raw)) !== null) {
    toolCalls.push({ type: "writeFile", path: m[1], content: m[2] });
  }

  // runCommand
  runCommandRegex.lastIndex = 0;
  while ((m = runCommandRegex.exec(raw)) !== null) {
    toolCalls.push({ type: "runCommand", command: m[1].trim() });
  }

  // remove all tags for the “clean” text we store in history
  const cleanText = raw
    .replace(readFileRegex, "")
    .replace(writeFileRegex, "")
    .replace(runCommandRegex, "")
    .trim();

  return { toolCalls, cleanText };
}

module.exports = { extractTools };
