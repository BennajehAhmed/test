// src/toolRunner.js
const vscode = require("vscode");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const Semaphore = require("semaphore-async-await").default;
const shellSema = new Semaphore(3); // max 3 concurrent

/**
 * All paths are forced to be inside the first workspace folder.
 */
function safePath(p) {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) throw new Error("No workspace folder open");
  const full = vscode.Uri.file(p).fsPath;
  if (!full.startsWith(ws)) throw new Error("Path outside workspace");
  return full;
}

const toolRunner = {
  async readFile(rawPath) {
    const filePath = safePath(rawPath);
    const data = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    return data.toString();
  },

  async writeFile(rawPath, content) {
    const filePath = safePath(rawPath);
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(require("path").dirname(filePath))
    );
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(filePath),
      Buffer.from(content, "utf8")
    );
    return "ok";
  },

  async runCommand(cmd) {
    await shellSema.acquire();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd,
        timeout: 15000,
        maxBuffer: 1024 * 1024, // 1 MB
      });
      return { stdout, stderr, exitCode: 0 };
    } finally {
      shellSema.release();
    }
  },
};

module.exports = toolRunner;
