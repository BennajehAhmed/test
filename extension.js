const { getChatCompletion } = require("./api");
const vscode = require("vscode");
const path = require("path");
const fs = require("fs").promises;
const crypto = require("crypto");

const chatHistories = new Map();

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("extension.open-chat", async () => {
      const panel = vscode.window.createWebviewPanel(
        "llmChat",
        "LLM Chat",
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.file(path.join(context.extensionPath, "media")),
          ],
        }
      );

      let chatHistory = chatHistories.get(panel) || [];
      chatHistories.set(panel, chatHistory);

      const openDocs = getOpenDocuments();
      panel.webview.html = getWebviewContent(
        panel.webview,
        context.extensionPath,
        chatHistory
      );

      panel.webview.postMessage({
        command: "initHistory",
        history: chatHistory,
      });

      setupMessageHandlers(panel, openDocs, chatHistory, context);
    })
  );

  context.subscriptions.push({
    dispose: () => {
      chatHistories.clear();
    },
  });
}

function getOpenDocuments() {
  return vscode.workspace.textDocuments
    .filter((doc) => !doc.isUntitled && doc.uri.scheme === "file")
    .map((doc) => ({
      path: doc.uri.fsPath,
      content: doc.getText(),
    }));
}

function setupMessageHandlers(panel, openDocs, chatHistory, context) {
  panel.webview.onDidReceiveMessage(async (message) => {
    try {
      switch (message.command) {
        case "sendToLLM":
          chatHistory.push({
            role: "user",
            content: message.text,
            timestamp: new Date().toISOString(),
          });
          handleLLMRequest(panel, openDocs, message.text, chatHistory);
          break;
        case "acceptFile":
          await handleFileAccept(message.path, message.newContent);
          break;
        case "copyToClipboard":
          await handleCopyToClipboard(message.content);
          break;
        case "clearHistory":
          const choice = await vscode.window.showWarningMessage(
            "Are you sure you want to clear the chat history? This cannot be undone.",
            { modal: true },
            "Clear History"
          );
          if (choice === "Clear History") {
            chatHistory.length = 0;
            panel.webview.postMessage({ command: "historyCleared" });
          }
          break;
        case "regenerate":
          if (
            chatHistory.length > 0 &&
            chatHistory[chatHistory.length - 1].role === "user"
          ) {
            const lastUserMessage = chatHistory.pop().content;
            handleLLMRequest(panel, openDocs, lastUserMessage, chatHistory);
          }
          break;
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Operation failed: ${error.message}`);
    }
  });

  panel.onDidDispose(() => {
    chatHistories.delete(panel);
  });
}

async function handleLLMRequest(panel, openDocs, userText, chatHistory) {
  panel.webview.postMessage({ command: "setLoading", isLoading: true });
  try {
    const response = await getChatCompletion(chatHistory, openDocs);
    chatHistory.push({
      role: "assistant",
      content: response,
      timestamp: new Date().toISOString(),
    });
    panel.webview.postMessage({
      command: "llmResponse",
      raw: response,
    });
  } catch (error) {
    vscode.window.showErrorMessage(`LLM request failed: ${error.message}`);
    panel.webview.postMessage({
      command: "llmError",
      error: error.message,
    });
  } finally {
    panel.webview.postMessage({ command: "setLoading", isLoading: false });
  }
}

async function handleFileAccept(filePath, newContent) {
  try {
    await fs.writeFile(filePath, newContent, "utf8");
    vscode.window.showInformationMessage(`Updated ${path.basename(filePath)}`);
    return true;
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to write to ${filePath}: ${error.message}`
    );
    return false;
  }
}

async function handleCopyToClipboard(content) {
  await vscode.env.clipboard.writeText(content);
  vscode.window.showInformationMessage("Copied to clipboard!");
}

function generateNonce() {
  return crypto.randomBytes(16).toString("base64");
}

function getWebviewContent(webview, extensionPath, chatHistory) {
  const nonce = generateNonce();
  const cspSource = webview.cspSource;

  return /*html*/ `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" 
          content="default-src 'none'; 
                   img-src ${cspSource} https:; 
                   script-src 'nonce-${nonce}'; 
                   style-src ${cspSource} 'unsafe-inline';
                   font-src ${cspSource}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    
    <style>
      :root {
        --bg: var(--vscode-editor-background, #1e1e1e);
        --fg: var(--vscode-editor-foreground, #d4d4d4);
        --border: var(--vscode-editorLineNumber-foreground, #444);
        --accent: var(--vscode-button-background, #0e639c);
        --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
        --pre-bg: var(--vscode-editorGroupHeader-tabsBackground, #252526);
        --user-msg: var(--vscode-inputValidation-infoBackground, rgba(10, 132, 255, 0.15));
        --assistant-msg: var(--vscode-editorWidget-background, rgba(100, 100, 100, 0.15));
        --error: var(--vscode-inputValidation-errorBackground, #5a1d1d);
        --success: var(--vscode-inputValidation-infoBorder, #2e7d32);
        --warning: var(--vscode-inputValidation-warningBackground, #5a4a00);
      }
      * { 
        box-sizing: border-box; 
        margin: 0; 
        padding: 0; 
      }
      body {
        height: 100vh; 
        display: flex; 
        flex-direction: column; 
        background: var(--bg);
        color: var(--fg); 
        font-family: var(--vscode-font-family, sans-serif);
        font-size: var(--vscode-font-size, 13px); 
        line-height: 1.5; 
        overflow: hidden;
      }
      #chat-container { 
        flex: 1; 
        display: flex; 
        flex-direction: column; 
        overflow: hidden; 
        position: relative; 
      }
      #history { 
        flex: 1; 
        overflow-y: auto; 
        padding: 16px; 
        display: flex; 
        flex-direction: column; 
        gap: 24px; 
        scroll-behavior: smooth;
      }
      .message { 
        max-width: 90%; 
        padding: 16px; 
        border-radius: 8px; 
        animation: fadeIn 0.3s ease-out; 
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1); 
        position: relative;
        transition: transform 0.2s, box-shadow 0.2s;
      }
      .message:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
      }
      .user-message { 
        align-self: flex-end; 
        background: var(--user-msg); 
        border-bottom-right-radius: 2px; 
        border: 1px solid rgba(10, 132, 255, 0.2);
      }
      .assistant-message { 
        align-self: flex-start; 
        background: var(--assistant-msg); 
        border-bottom-left-radius: 2px;
        border: 1px solid rgba(100, 100, 100, 0.2);
      }
      .message-header { 
        display: flex; 
        align-items: center; 
        justify-content: space-between; 
        margin-bottom: 12px; 
        font-weight: 600; 
        font-size: 0.95em; 
        opacity: 0.9; 
      }
      .message-role {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .message-actions {
        display: flex;
        gap: 8px;
        opacity: 0;
        transition: opacity 0.2s;
      }
      .message:hover .message-actions {
        opacity: 1;
      }
      .message-timestamp { 
        font-size: 0.8em; 
        opacity: 0.7; 
      }
      .message-content { 
        white-space: pre-wrap; 
        word-break: break-word; 
        line-height: 1.6;
      }
      .file-block { 
        background: var(--pre-bg); 
        border: 1px solid var(--border); 
        border-radius: 6px; 
        overflow: visible; /* or overflow-y: auto; */
  		height: auto;
        margin: 16px 0; 
        animation: scaleIn 0.2s ease-out; 
        transition: box-shadow 0.2s;
      }
      .file-block:hover {
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
      }
      .file-header { 
        padding: 10px 16px; 
        background: rgba(0, 0, 0, 0.1); 
        font-family: var(--vscode-editor-font-family, monospace); 
        font-size: 0.85em; 
        display: flex; 
        justify-content: space-between; 
        align-items: center; 
        border-bottom: 1px solid var(--border);
      }
      .file-path {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
      }
      .file-actions { 
        display: flex; 
        gap: 8px; 
      }
      .file-content { 
        padding: 16px;
        font-family: var(--vscode-editor-font-family, monospace); 
        background: rgba(0, 0, 0, 0.05);
      }
      .file-content textarea { 
        width: 100%; 
		height: auto;
  		min-height: 200px; /* Optional: to give initial space */
  		resize: vertical;  /* Allows manual vertical resizing */
        background: transparent; 
        color: inherit; 
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 12px;
        resize: vertical; 
        font-family: inherit; 
        font-size: inherit; 
        line-height: inherit;
        white-space: pre;
        tab-size: 4;
        transition: border-color 0.2s;
      }
      .file-content textarea:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 1px var(--accent);
      }
      .file-footer {
        padding: 12px 16px;
        border-top: 1px solid var(--border);
        background: rgba(0, 0, 0, 0.05);
        display: flex;
        justify-content: flex-end;
        gap: 10px;
      }
      .button { 
        padding: 6px 14px; 
        border: none; 
        border-radius: 4px; 
        cursor: pointer; 
        font-size: 0.85em; 
        transition: all 0.2s ease; 
        display: inline-flex; 
        align-items: center; 
        justify-content: center;
        gap: 6px;
        font-weight: 600;
      }
      .button-primary { 
        background: var(--accent); 
        color: white; 
      }
      .button-primary:hover { 
        background: var(--accent-hover); 
      }
      .button-secondary { 
        background: transparent; 
        color: var(--fg); 
        border: 1px solid var(--border); 
      }
      .button-secondary:hover { 
        background: rgba(255, 255, 255, 0.05); 
      }
      .button-success {
        background: var(--success);
        color: white;
      }
      .button-icon {
        padding: 6px;
        border-radius: 4px;
        background: transparent;
        border: none;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        opacity: 0.7;
        transition: all 0.2s;
      }
      .button-icon:hover {
        opacity: 1;
        background: rgba(255, 255, 255, 0.1);
      }
      #input-area { 
        padding: 16px; 
        border-top: 1px solid var(--border); 
        background: var(--pre-bg); 
        position: relative; 
      }
      #input-container { 
        display: flex; 
        gap: 12px; 
        position: relative;
      }
      #input { 
        flex: 1; 
        resize: none; 
        padding: 14px 16px; 
        border: 1px solid var(--border); 
        border-radius: 8px; 
        background: var(--bg); 
        color: var(--fg); 
        font-family: inherit; 
        font-size: inherit; 
        min-height: 44px; 
        max-height: 200px; 
        transition: border-color 0.2s, box-shadow 0.2s;
        line-height: 1.5;
      }
      #input:focus { 
        outline: none; 
        border-color: var(--accent); 
        box-shadow: 0 0 0 2px rgba(14, 99, 156, 0.3);
      }
      #input::placeholder {
        color: var(--vscode-input-placeholderForeground, #888);
      }
      #send-button { 
        padding: 0 20px; 
        height: 44px;
        background: var(--accent); 
        color: white; 
        border: none; 
        border-radius: 8px; 
        cursor: pointer; 
        align-self: flex-end; 
        transition: background 0.2s, transform 0.1s;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 600;
      }
      #send-button:hover { 
        background: var(--accent-hover); 
      }
      #send-button:active {
        transform: scale(0.97);
      }
      #send-button:disabled { 
        background: var(--vscode-button-secondaryBackground); 
        color: var(--vscode-button-secondaryForeground); 
        opacity: 0.7; 
        cursor: not-allowed;
        transform: none;
      }
      .loader { 
        display: none; 
        text-align: center; 
        padding: 16px; 
        color: var(--vscode-descriptionForeground); 
        font-style: italic; 
      }
      .typing-indicator { 
        display: inline-flex; 
        align-items: center; 
        gap: 6px; 
        padding: 12px 16px;
        background: var(--assistant-msg);
        border-radius: 18px;
        border: 1px solid var(--border);
        position: absolute;
        bottom: 80px;
        left: 50%;
        transform: translateX(-50%);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        z-index: 100;
      }
      .typing-dot { 
        width: 8px; 
        height: 8px; 
        background: var(--accent); 
        border-radius: 50%; 
        opacity: 0.6; 
        animation: pulse 1.5s infinite ease-in-out; 
      }
      .typing-dot:nth-child(2) { animation-delay: 0.2s; }
      .typing-dot:nth-child(3) { animation-delay: 0.4s; }
      .history-controls { 
        position: absolute; 
        top: 16px; 
        right: 16px; 
        z-index: 10; 
        display: flex; 
        gap: 8px; 
        background: var(--pre-bg);
        border-radius: 6px;
        padding: 6px;
        border: 1px solid var(--border);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
      }
      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        height: 100%;
        padding: 40px;
        opacity: 0.6;
      }
      .empty-state svg {
        width: 64px;
        height: 64px;
        margin-bottom: 16px;
        opacity: 0.3;
      }
      .empty-state h3 {
        margin-bottom: 8px;
        font-weight: 600;
      }
      .empty-state p {
        max-width: 400px;
        line-height: 1.6;
      }
      .error-message {
        background: var(--error);
        color: var(--vscode-errorForeground, #f48771);
        padding: 12px 16px;
        border-radius: 6px;
        margin: 16px 0;
        border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
        display: flex;
        align-items: flex-start;
        gap: 10px;
      }
      .error-message svg {
        min-width: 18px;
      }
      .regenerate-container {
        display: flex;
        justify-content: center;
        margin-top: 8px;
      }
      
      .code-block-wrapper {
        background: var(--pre-bg); 
        border: 1px solid var(--border); 
        border-radius: 6px; 
        overflow: hidden; 
        margin: 16px 0; 
      }
      .code-block-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 12px;
        background: rgba(0,0,0,0.1);
        font-size: 0.8em;
        color: var(--vscode-descriptionForeground);
        font-family: var(--vscode-editor-font-family, monospace);
      }
      .code-block-header .button-icon {
        padding: 4px;
      }
      .message-content pre {
        margin: 0;
        padding: 16px;
        background: transparent;
        border: none;
        border-radius: 0;
        overflow-x: auto;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 0.9em;
        line-height: 1.6;
      }
      .message-content pre code {
        font-family: inherit;
        white-space: pre;
        background: none;
        padding: 0;
      }

      @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes scaleIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
      @keyframes pulse { 0%, 100% { transform: scale(0.9); opacity: 0.6; } 50% { transform: scale(1.1); opacity: 1; } }
    </style>
  </head>
  <body>
    <div id="chat-container">
      <div class="history-controls">
        <button id="clear-history" class="button button-secondary" title="Clear chat history">
           <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <line x1="10" y1="11" x2="10" y2="17"></line>
            <line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
          Clear
        </button>
      </div>
      <div id="history"></div>
      <div class="loader" id="loader">
        <div class="typing-indicator">
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
          <span>Assistant is thinking...</span>
        </div>
      </div>
    </div>
    <div id="input-area">
      <div id="input-container">
        <textarea id="input" placeholder="Ask anything... (Shift+Enter for new line)" rows="1" aria-label="Message input"></textarea>
        <button id="send-button" aria-label="Send message">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
          Send
        </button>
      </div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const historyElement = document.getElementById('history');
      const inputElement = document.getElementById('input');
      const sendButton = document.getElementById('send-button');
      const loaderElement = document.getElementById('loader');
      const clearHistoryButton = document.getElementById('clear-history');
      
      inputElement.addEventListener('input', () => {
        inputElement.style.height = 'auto';
        inputElement.style.height = Math.min(inputElement.scrollHeight, 200) + 'px';
      });
      
      inputElement.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
      
      sendButton.addEventListener('click', sendMessage);
      clearHistoryButton.addEventListener('click', clearHistory);
      
      function sendMessage() {
        const text = inputElement.value.trim();
        if (!text || sendButton.disabled) return;
        
        appendMessage('user', text);
        vscode.postMessage({ command: 'sendToLLM', text });
        inputElement.value = '';
        inputElement.style.height = 'auto';
        inputElement.focus();
      }
      
      function clearHistory() {
        vscode.postMessage({ command: 'clearHistory' });
      }

      function populateContent(element, markdownContent) {
        element.innerHTML = ''; // Clear previous content
        const parts = markdownContent.split(/(\`\`\`[\\s\\S]*?\`\`\`)/g);

        parts.forEach(part => {
            // FIXED: Use trimStart/trimEnd to handle whitespace around code blocks
            if (part.trimStart().startsWith('\`\`\`') && part.trimEnd().endsWith('\`\`\`')) {
                const codeBlockWrapper = document.createElement('div');
                codeBlockWrapper.className = 'code-block-wrapper';
                
                const innerContent = part.slice(3, -3).trim();
                const firstLineBreak = innerContent.indexOf('\\n');
                const language = (firstLineBreak !== -1) ? innerContent.substring(0, firstLineBreak).trim() : '';
                const codeText = (firstLineBreak !== -1) ? innerContent.substring(firstLineBreak + 1) : innerContent;
                
                const header = document.createElement('div');
                header.className = 'code-block-header';
                
                const langSpan = document.createElement('span');
                langSpan.textContent = language || 'code';
                header.appendChild(langSpan);

                const copyBtn = document.createElement('button');
                copyBtn.className = 'button-icon';
                copyBtn.title = 'Copy code';
                copyBtn.innerHTML = \`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>\`;
                copyBtn.onclick = () => {
                    vscode.postMessage({ command: 'copyToClipboard', content: codeText });
                    showToast('Copied to clipboard!');
                };
                header.appendChild(copyBtn);

                const preEl = document.createElement('pre');
                const codeEl = document.createElement('code');
                if (language) {
                    codeEl.className = \`language-\${language}\`;
                }
                codeEl.textContent = codeText;
                
                preEl.appendChild(codeEl);
                codeBlockWrapper.appendChild(header);
                codeBlockWrapper.appendChild(preEl);
                element.appendChild(codeBlockWrapper);

            } else if (part.trim()) {
                const textEl = document.createElement('div');
                textEl.textContent = part;
                element.appendChild(textEl);
            }
        });
      }
      
      function appendMessage(role, content) {
        if (!content.trim()) return;
        
        const messageElement = document.createElement('div');
        messageElement.className = \`message \${role}-message\`;
        
        const headerElement = document.createElement('div');
        headerElement.className = 'message-header';
        
        const roleElement = document.createElement('div');
        roleElement.className = 'message-role';
        roleElement.innerHTML = \`
          <span>\${role === 'user' ? 'You' : 'Assistant'}</span>
          <span class="message-timestamp">\${formatTime(new Date())}</span>
        \`;
        
        const actionsElement = document.createElement('div');
        actionsElement.className = 'message-actions';
        
        if (role === 'assistant') {
          const regenerateButton = document.createElement('button');
          regenerateButton.className = 'button-icon';
          regenerateButton.title = 'Regenerate response';
          regenerateButton.innerHTML = \`
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
              <path d="M3 3v5h5"></path>
            </svg>
          \`;
          regenerateButton.addEventListener('click', () => {
            vscode.postMessage({ command: 'regenerate' });
          });
          actionsElement.appendChild(regenerateButton);
        }
        
        headerElement.appendChild(roleElement);
        headerElement.appendChild(actionsElement);
        
        const contentElement = document.createElement('div');
        contentElement.className = 'message-content';

        if (role === 'assistant') {
          populateContent(contentElement, content);
        } else {
          contentElement.textContent = content;
        }
        
        messageElement.appendChild(headerElement);
        messageElement.appendChild(contentElement);
        historyElement.appendChild(messageElement);
        scrollToBottom();
      }
      
      function appendFileBlock(path, rawContent) {
        const blockElement = document.createElement('div');
        blockElement.className = 'file-block';
        
        const shortPath = path.split(/[\\\\/]/).pop();
        
        const headerElement = document.createElement('div');
        headerElement.className = 'file-header';
        headerElement.innerHTML = \`
          <div class="file-path" title="\${path}">\${shortPath}</div>
          <div class="file-actions">
            <button class="button-icon copy-button" title="Copy to clipboard">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
          </div>
        \`;
        
        const contentElement = document.createElement('div');
        contentElement.className = 'file-content';
        const textarea = document.createElement('textarea');
        textarea.spellcheck = false;
        textarea.textContent = rawContent;
        contentElement.appendChild(textarea);
        
        const footerElement = document.createElement('div');
        footerElement.className = 'file-footer';
        footerElement.innerHTML = \`
          <button class="button button-secondary cancel-button">Cancel</button>
          <button class="button button-primary accept-button">Accept Changes</button>
        \`;
        
        blockElement.appendChild(headerElement);
        blockElement.appendChild(contentElement);
        blockElement.appendChild(footerElement);
        historyElement.appendChild(blockElement);
        scrollToBottom();
        
        blockElement.querySelector('.copy-button').addEventListener('click', () => {
          vscode.postMessage({ command: 'copyToClipboard', content: textarea.value });
          showToast('Copied to clipboard!');
        });
        
        blockElement.querySelector('.accept-button').addEventListener('click', () => {
          vscode.postMessage({ command: 'acceptFile', path, newContent: textarea.value });
          blockElement.remove();
        });
        
        blockElement.querySelector('.cancel-button').addEventListener('click', () => {
          blockElement.remove();
        });
      }
      
      function formatTime(date) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      
      function showToast(message) {
        const toast = document.createElement('div');
        toast.className = 'typing-indicator';
        toast.textContent = message;
        toast.style.bottom = '80px';
        toast.style.animation = 'fadeIn 0.3s';
        document.body.appendChild(toast);
        
        setTimeout(() => {
          toast.style.opacity = '0';
          setTimeout(() => {
            document.body.removeChild(toast);
          }, 300);
        }, 2000);
      }
      
      function scrollToBottom() {
        historyElement.scrollTop = historyElement.scrollHeight;
      }
      
      window.addEventListener('message', event => {
        const { command, ...data } = event.data;
        
        switch (command) {
          case 'llmResponse':
            parseLLMResponse(data.raw);
            break;
          case 'setLoading':
            loaderElement.style.display = data.isLoading ? 'block' : 'none';
            sendButton.disabled = data.isLoading;
            inputElement.disabled = data.isLoading;
            if (!data.isLoading) {
              inputElement.focus();
            }
            scrollToBottom();
            break;
          case 'initHistory':
            renderHistory(data.history);
            break;
          case 'historyCleared':
            historyElement.innerHTML = '';
            showEmptyState();
            break;
          case 'llmError':
            showError(data.error);
            break;
        }
      });
      
      function renderHistory(history) {
        historyElement.innerHTML = '';
        if (history.length === 0) {
          showEmptyState();
          return;
        }
        
        history.forEach(item => {
          if (item.role === 'user') {
            appendMessage('user', item.content);
          } else if (item.role === 'assistant') {
            parseLLMResponse(item.content);
          }
        });
        scrollToBottom();
      }
      
      function showEmptyState() {
        historyElement.innerHTML = \`
          <div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            <h3>Start a conversation</h3>
            <p>Ask questions, request code explanations, or generate content. Your chat history will appear here.</p>
          </div>
        \`;
      }
      
      function showError(error) {
        const errorElement = document.createElement('div');
        errorElement.className = 'error-message';
        errorElement.innerHTML = \`
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <div>
            <strong>Request failed:</strong> \${error || 'Unknown error'}
          </div>
        \`;
        
        const regenerateContainer = document.createElement('div');
        regenerateContainer.className = 'regenerate-container';
        regenerateContainer.innerHTML = \`
          <button class="button button-secondary" id="regenerate-button">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
              <path d="M3 3v5h5"></path>
            </svg>
            Try Again
          </button>
        \`;
        
        const container = document.createElement('div');
        container.appendChild(errorElement);
        container.appendChild(regenerateContainer);
        historyElement.appendChild(container);
        scrollToBottom();
        
        document.getElementById('regenerate-button').addEventListener('click', () => {
          vscode.postMessage({ command: 'regenerate' });
        });
      }
      
      function parseLLMResponse(raw) {
        let lastIndex = 0;
        const tagRe = /<file path="([^"]+)">([\\s\\S]*?)<\\/file>/g;
        let match;
        
        const hasFileBlocks = /<file path="[^"]+">/g.test(raw);
        if (!hasFileBlocks) {
          appendMessage('assistant', raw);
          return;
        }
        
        while ((match = tagRe.exec(raw))) {
          if (match.index > lastIndex) {
            const textChunk = raw.substring(lastIndex, match.index).trim();
            if (textChunk) appendMessage('assistant', textChunk);
          }
          
          const filePath = match[1];
          const fileContent = match[2];
          appendFileBlock(filePath, fileContent);
          lastIndex = tagRe.lastIndex;
        }
        
        if (lastIndex < raw.length) {
          const textChunk = raw.substring(lastIndex).trim();
          if (textChunk) appendMessage('assistant', textChunk);
        }
      }
      
      // Initial setup
      if (${chatHistory.length} === 0) {
        showEmptyState();
      }
      inputElement.focus();
    </script>
  </body>
  </html>
  `;
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
