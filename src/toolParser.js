// src/toolParser.js
const readFileRegex = /<readFile\s+path="([^"]+)"\s*\/>/g;
const writeFileRegex =
  /<writeFile\s+path="([^"]+)"\s*>([\s\S]*?)<\/writeFile>/g;
const runCommandRegex = /<runCommand>([\s\S]*?)<\/runCommand>/g;
const listDirectoryRegex = /<list_directory\s+path="([^"]+)"\s*\/>/g;
const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/g;

/**
 * Returns {plan, toolCalls, thoughts}
 *   plan: The textual plan part of the response
 *   toolCalls: array of {type, path?, content?, command?}
 *   thoughts: The textual thoughts part of the response
 */
function extractTools(raw) {
  const toolCalls = [];
  let plan = raw;
  let thoughts = "";

  // thinking
  let m;
  while ((m = thinkingRegex.exec(raw)) !== null) {
    thoughts = m[1].trim();
    plan = plan.replace(m[0], "");
  }

  // readFile
  readFileRegex.lastIndex = 0;
  while ((m = readFileRegex.exec(raw)) !== null) {
    toolCalls.push({ type: "readFile", path: m[1] });
    plan = plan.replace(m[0], "");
  }

  // writeFile
  writeFileRegex.lastIndex = 0;
  while ((m = writeFileRegex.exec(raw)) !== null) {
    toolCalls.push({ type: "writeFile", path: m[1], content: m[2] });
    plan = plan.replace(m[0], "");
  }

  // runCommand
  runCommandRegex.lastIndex = 0;
  while ((m = runCommandRegex.exec(raw)) !== null) {
    toolCalls.push({ type: "runCommand", command: m[1].trim() });
    plan = plan.replace(m[0], "");
  }

  // listDirectory
  listDirectoryRegex.lastIndex = 0;
  while ((m = listDirectoryRegex.exec(raw)) !== null) {
    toolCalls.push({ type: "list_directory", path: m[1] });
    plan = plan.replace(m[0], "");
  }

  return { plan: plan.trim(), toolCalls, thoughts };
}

module.exports = { extractTools };
