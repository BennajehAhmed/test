// chatViewProvider.js
const vscode = require("vscode");
const path = require("path");
const fs = require("fs").promises;
const crypto = require("crypto");
const { getChatCompletion } = require("./api");
const { parseLLMResponse } = require("./llmParser");
const { extractTools } = require("./toolParser");
const toolRunner = require("./toolRunner");
const { getSystemPromptAgent } = require("./systemPromptAgent");

const MAX_AGENT_LOOPS = 15;

class ChatViewProvider {
  static viewType = "llmChat.chatView";

  constructor(extensionUri) {
    this._extensionUri = extensionUri;
    this._history = [];
    this._mode = "edit"; // 'edit' | 'agent'
  }

  /* ------------------------------------------------------------------ */
  /*  Webview setup                                                       */
  /* ------------------------------------------------------------------ */
  resolveWebviewView(webviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, "media")],
    };
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((m) => this._handleMessage(m));

    /* ----------  one-time virtual-doc provider for diffs ---------- */
    const diffScheme = "llmchat-diff";
    const provider = {
      provideTextDocumentContent(uri) {
        return Buffer.from(uri.query, "base64").toString("utf8");
      },
    };
    this._diffReg = vscode.workspace.registerTextDocumentContentProvider(
      diffScheme,
      provider
    );
    webviewView.onDidDispose(() => this._diffReg.dispose());
  }

  async _handleSlash(slash, arg) {
    switch (slash) {
      case "explain":
        // 1. Resolve file (arg can be absolute path or "selected")
        const uri =
          arg === "selected"
            ? vscode.window.activeTextEditor?.document.uri
            : vscode.Uri.file(arg);
        if (!uri) {
          this._view.webview.postMessage({
            command: "llmError",
            error: "No file or selection to explain.",
          });
          return;
        }
        // 2. Read content
        const content = await vscode.workspace.fs.readFile(uri);
        // 3. Push synthetic user message + auto-run
        this._history.push({
          role: "user",
          content: `Explain the following code in ${uri.fsPath}:\n\n${content}`,
        });
        await this._handleLLMRequest();
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Message dispatcher                                                  */
  /* ------------------------------------------------------------------ */
  async _handleMessage(message) {
    switch (message.command) {
      case "setMode":
        this._mode = message.mode; // 'edit' | 'agent'
        return;
      case "slash":
        await this._handleSlash(message.slash, message.arg);
        return;
      case "sendToLLM":
        this._history.push({ role: "user", content: message.text });
        await this._handleLLMRequest();
        return;

      case "acceptFile":
        await this._handleAccept(message);
        return;

      case "copyToClipboard":
        await vscode.env.clipboard.writeText(message.content);
        vscode.window.showInformationMessage("Copied to clipboard!");
        return;

      case "clearHistory":
        const choice = await vscode.window.showWarningMessage(
          "Are you sure you want to clear the chat history?",
          { modal: true },
          "Clear History"
        );
        if (choice === "Clear History") {
          this._history = [];
          this._view.webview.postMessage({ command: "historyCleared" });
        }
        return;

      case "regenerate":
        if (
          this._history.length > 1 &&
          this._history[this._history.length - 2]?.role === "user"
        ) {
          this._history.pop();
          const lastUser = this._history.pop();
          if (lastUser) {
            this._history.push(lastUser);
            await this._handleLLMRequest();
          }
        }
        return;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Handle Accept (diff OR direct create)                               */
  /* ------------------------------------------------------------------ */
  async _handleAccept({ path: filePath, newContent, blockId }) {
    try {
      // 1. File does NOT exist → create directly, no diff
      try {
        await fs.access(filePath);
      } catch {
        await fs.writeFile(filePath, newContent, "utf8");
        vscode.window.showInformationMessage(
          `Created ${path.basename(filePath)}`
        );
        this._view.webview.postMessage({ command: "fileAccepted", blockId });
        return;
      }

      // 2. File exists → show diff
      const currentContent = await fs.readFile(filePath, "utf8");
      const fileName = path.basename(filePath);

      const nonce =
        Date.now().toString(36) + Math.random().toString(36).slice(2);
      const leftUri = vscode.Uri.parse(
        `llmchat-diff:left-${nonce}?${Buffer.from(currentContent).toString(
          "base64"
        )}`
      );
      const rightUri = vscode.Uri.parse(
        `llmchat-diff:right-${nonce}?${Buffer.from(newContent).toString(
          "base64"
        )}`
      );

      await vscode.commands.executeCommand(
        "vscode.diff",
        leftUri,
        rightUri,
        `Preview: ${fileName}`
      );

      // Wait until the diff is closed
      const closeListener = vscode.window.onDidChangeVisibleTextEditors(
        async (editors) => {
          if (editors.some((e) => e.document.uri.scheme === "llmchat-diff"))
            return; // still open

          closeListener.dispose();

          const choice = await vscode.window.showInformationMessage(
            `Apply the proposed changes to ${fileName}?`,
            { modal: true },
            "Apply",
            "Discard"
          );

          if (choice === "Apply") {
            await fs.writeFile(filePath, newContent, "utf8");
            vscode.window.showInformationMessage(
              `Updated ${path.basename(filePath)}`
            );
            this._view.webview.postMessage({
              command: "fileAccepted",
              blockId,
            });
          }
          // close only the diff tab, not other editors
          await vscode.commands.executeCommand(
            "workbench.action.closeActiveEditor"
          );
        }
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to process file ${filePath}: ${err.message}`
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /*  LLM request                                                         */
  /* ------------------------------------------------------------------ */
  async _handleLLMRequest() {
    if (!this._view) return;
    this._view.webview.postMessage({ command: "setLoading", isLoading: true });

    try {
      const openDocs = this._getOpenDocuments();
      const systemPrompt =
        this._mode === "agent"
          ? getSystemPromptAgent(openDocs)
          : require("./systemPrompt").getSystemPrompt(openDocs);

      let historyToSend = [
        { role: "system", content: systemPrompt },
        ...this._history,
      ];

      if (this._mode !== "agent") {
        const raw = await getChatCompletion(historyToSend, []);
        this._history.push({ role: "assistant", content: raw });
        const parts = parseLLMResponse(raw);
        this._view.webview.postMessage({ command: "llmResponse", parts });
        return;
      }

      // Agent mode
      let loops = 0;
      // NEW constant
      const MAX_AGENT_LOOPS = 15;

      // inside _handleLLMRequest
      while (loops < MAX_AGENT_LOOPS) {
        loops++;

        const raw = await getChatCompletion(historyToSend, []);

        const { plan, toolCalls, thoughts } = extractTools(raw);

        if (thoughts) {
          this._view.webview.postMessage({
            command: "agentThought",
            thought: thoughts,
          });
        }

        // push ONCE
        this._history.push({ role: "assistant", content: raw });
        historyToSend.push({ role: "assistant", content: raw });

        if (plan) {
          // Only send to web-view; NOT rendered again later
          this._view.webview.postMessage({ command: "agentPlan", plan });
        }

        if (toolCalls.length !== 0) break;

        for (const tool of toolCalls) {
          let obs;
          try {
            this._view.webview.postMessage({
              command: "agentTrace",
              icon: "fas fa-cogs",
              title: `Running: ${tool.type}`,
              body:
                tool.type === "writeFile"
                  ? `Path: ${tool.path}`
                  : `Command: ${tool.command || tool.path}`,
            });

            switch (tool.type) {
              case "readFile":
                obs = await toolRunner.readFile(tool.path);
                break;
              case "writeFile":
                obs = await toolRunner.writeFile(tool.path, tool.content);
                break;
              case "runCommand":
                obs = await toolRunner.runCommand(tool.command);
                break;
              case "list_directory":
                obs = await toolRunner.list_directory(tool.path);
                break;
              default:
                throw new Error(`Unknown tool: ${tool.type}`);
            }
          } catch (err) {
            obs = { error: err.message };
          }

          const obsText = `<observation type="${tool.type}">${JSON.stringify(
            obs
          )}</observation>`;
          this._history.push({ role: "user", content: obsText });
          historyToSend.push({ role: "user", content: obsText });

          this._view.webview.postMessage({
            command: "agentTrace",
            icon: "fas fa-check",
            title: `${tool.type} result`,
            body: JSON.stringify(obs, null, 2),
            isError: !!obs.error,
          });
        }
      }
    } catch (err) {
      console.error("LLM/Agent failed:", err);
      this._view.webview.postMessage({
        command: "llmError",
        error: err.message,
      });
    } finally {
      this._view.webview.postMessage({
        command: "setLoading",
        isLoading: false,
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                             */
  /* ------------------------------------------------------------------ */
  _getOpenDocuments() {
    return vscode.workspace.textDocuments
      .filter((d) => !d.isUntitled && d.uri.scheme === "file")
      .map((d) => ({ path: d.uri.fsPath, content: d.getText() }));
  }

  _getHtmlForWebview(webview) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "main.css")
    );
    const highlightScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "highlight.min.js")
    );
    const highlightStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "github-dark.min.css")
    );
    const fontAwesomeUri =
      "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css";
    const nonce = crypto.randomBytes(16).toString("base64");

    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} ${fontAwesomeUri}; script-src 'nonce-${nonce}'; font-src 'self' data: https:;">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="${styleUri}" rel="stylesheet">
        <link href="${highlightStyleUri}" rel="stylesheet">
        <link href="${fontAwesomeUri}" rel="stylesheet">
        <title>LLM Chat</title>
      </head>
      <body>
        <div id="chat-container">
          <div class="history-controls">
            <button id="clear-history" class="button button-secondary" title="Clear chat history">
              <i class="fas fa-trash-alt"></i><span>Clear</span>
            </button>
          </div>
          <div id="history"></div>
          <div class="loader" id="loader">
            <div class="typing-indicator">
              <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
              <span>Assistant is thinking...</span>
            </div>
          </div>
        </div>
        <div id="input-area">
          <div id="input-container">
          <button id="toggle-mode" class="button button-secondary" title="Toggle Agent/Edit Mode">
            <i class="fas fa-robot"></i><span>Edit</span>
          </button>
            <textarea id="input" placeholder="Ask anything..." rows="1"></textarea>
            <button id="send-button" title="Send message"><i class="fas fa-paper-plane"></i></button>
          </div>
        </div>
        <script nonce="${nonce}" src="${highlightScriptUri}"></script>
        <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/markdown-it@13.0.1/dist/markdown-it.min.js"></script>
        <script nonce="${nonce}" src="${scriptUri}"></script>
      </body>
      </html>`;
  }
}

module.exports = { ChatViewProvider };
