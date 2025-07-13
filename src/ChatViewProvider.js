// chatViewProvider.js
const vscode = require("vscode");
const path = require("path");
const fs = require("fs").promises;
const crypto = require("crypto");
const { getChatCompletion } = require("./api");
const { parseLLMResponse } = require("./llmParser");

class ChatViewProvider {
  static viewType = "llmChat.chatView";

  constructor(extensionUri) {
    this._extensionUri = extensionUri;
    this._history = [];
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

  /* ------------------------------------------------------------------ */
  /*  Message dispatcher                                                  */
  /* ------------------------------------------------------------------ */
  async _handleMessage(message) {
    switch (message.command) {
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
      const response = await getChatCompletion(this._history, openDocs);
      this._history.push({ role: "assistant", content: response });
      const parts = parseLLMResponse(response);
      this._view.webview.postMessage({
        command: "llmResponse",
        parts,
      });
    } catch (err) {
      console.error("LLM Request Failed:", err);
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
