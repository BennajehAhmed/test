(function () {
  const vscode = acquireVsCodeApi();
  const historyElement = document.getElementById("history");
  const inputElement = document.getElementById("input");
  const sendButton = document.getElementById("send-button");
  const loaderElement = document.getElementById("loader");
  const clearHistoryButton = document.getElementById("clear-history");

  const md = window.markdownit({
    html: false,
    linkify: true,
    typographer: true,
    highlight: (str, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return `<pre class="hljs"><code>${
            hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
          }</code></pre>`;
        } catch (__) {}
      }
      return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
    },
  });

  sendButton.addEventListener("click", sendMessage);
  clearHistoryButton.addEventListener("click", () =>
    vscode.postMessage({ command: "clearHistory" })
  );
  inputElement.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  inputElement.addEventListener("input", () => {
    inputElement.style.height = "auto";
    inputElement.style.height = `${Math.min(inputElement.scrollHeight, 150)}px`;
  });

  window.addEventListener("message", (event) => {
    const { command, ...data } = event.data;
    switch (command) {
      case "llmResponse":
        renderAssistantResponse(data.parts);
        break;
      case "setLoading":
        setLoadingState(data.isLoading);
        break;
      case "historyCleared":
        historyElement.innerHTML = "";
        showEmptyState();
        break;
      case "llmError":
        showError(data.error);
        break;
      case "fileAccepted":
        updateFileBlockToAccepted(data.blockId);
        break;
    }
  });

  function sendMessage() {
    const text = inputElement.value.trim();
    if (!text || sendButton.disabled) return;
    appendUserMessage(text);
    vscode.postMessage({ command: "sendToLLM", text });
    inputElement.value = "";
    inputElement.style.height = "auto";
    inputElement.focus();
  }

  function setLoadingState(isLoading) {
    loaderElement.style.display = isLoading ? "block" : "none";
    sendButton.disabled = isLoading;
    inputElement.disabled = isLoading;
    if (!isLoading) inputElement.focus();
    scrollToBottom();
  }

  function renderAssistantResponse(parts) {
    const messageElement = createMessageElement("assistant");
    const contentElement = messageElement.querySelector(".message-content");
    parts.forEach((part) => {
      if (part.type === "text") {
        const textDiv = document.createElement("div");
        textDiv.innerHTML = md.render(part.content);
        contentElement.appendChild(textDiv);
        hasTextContent = true;
      } else if (part.type === "file") {
        appendFileBlock(part.path, part.content);
      }
    });
    scrollToBottom();
  }

  function appendUserMessage(content) {
    if (
      !historyElement.hasChildNodes() ||
      historyElement.querySelector(".empty-state")
    ) {
      historyElement.innerHTML = "";
    }
    const messageElement = createMessageElement("user");
    const contentElement = messageElement.querySelector(".message-content");
    contentElement.textContent = content;
    historyElement.appendChild(messageElement);
    scrollToBottom();
  }

  function createMessageElement(role) {
    if (
      !historyElement.hasChildNodes() ||
      historyElement.querySelector(".empty-state")
    ) {
      historyElement.innerHTML = "";
    }
    const isUser = role === "user";
    const messageElement = document.createElement("div");
    messageElement.className = `message ${
      isUser ? "user-message" : "assistant-message"
    }`;
    const timestamp = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    messageElement.innerHTML = `
      <div class="message-header">
        <div class="message-role"><span>${
          isUser ? "You" : "Assistant"
        }</span><span class="message-timestamp">${timestamp}</span></div>
        <div class="message-actions">
          ${
            !isUser
              ? `<button class="button-icon regenerate-button" title="Regenerate response"><i class="fas fa-sync-alt"></i></button>`
              : ""
          }
          <button class="button-icon copy-button" title="Copy content"><i class="far fa-copy"></i></button>
        </div>
      </div>
      <div class="message-content"></div>`;

    messageElement
      .querySelector(".copy-button")
      .addEventListener("click", (e) => {
        const content = e.currentTarget
          .closest(".message")
          .querySelector(".message-content").innerText;
        vscode.postMessage({ command: "copyToClipboard", content });
      });
    if (!isUser) {
      messageElement
        .querySelector(".regenerate-button")
        .addEventListener("click", () =>
          vscode.postMessage({ command: "regenerate" })
        );
    }
    return messageElement;
  }

  function appendFileBlock(path, rawContent) {
    const blockId = `file-block-${Date.now()}-${Math.random()}`;
    const blockElement = document.createElement("div");
    blockElement.className = "file-block";
    blockElement.dataset.blockId = blockId;
    const shortPath = path.split(/[\\/]/).pop();

    blockElement.innerHTML = `
      <div class="file-header">
        <div class="file-path" title="${path}">${shortPath}</div>
        <div class="file-actions">
            <button class="button-icon copy-button" title="Copy to clipboard"><i class="far fa-copy"></i></button>
        </div>
      </div>
      <div class="file-content">
        <div class="file-accepted-notice"><i class="fas fa-check-circle"></i> Changes Accepted</div>
        <textarea spellcheck="false"></textarea>
      </div>
      <div class="file-footer">
        <button class="button button-secondary cancel-button">Cancel</button>
        <button class="button button-primary accept-button">Accept Changes</button>
      </div>`;

    const textarea = blockElement.querySelector("textarea");
    textarea.value = rawContent;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
    textarea.addEventListener("input", () => {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    });

    blockElement.querySelector(".copy-button").addEventListener("click", () =>
      vscode.postMessage({
        command: "copyToClipboard",
        content: textarea.value,
      })
    );
    blockElement.querySelector(".accept-button").addEventListener("click", () =>
      vscode.postMessage({
        command: "acceptFile",
        path,
        newContent: textarea.value,
        blockId,
      })
    );
    blockElement
      .querySelector(".cancel-button")
      .addEventListener("click", () => blockElement.remove());

    historyElement.appendChild(blockElement);
    scrollToBottom();
  }

  function updateFileBlockToAccepted(blockId) {
    const blockElement = document.querySelector(`[data-block-id="${blockId}"]`);
    if (blockElement) {
      blockElement.classList.add("accepted");
      blockElement.querySelector("textarea").readOnly = true;
    }
  }

  function showError(error) {
    const errorContainer = document.createElement("div");
    errorContainer.className = "error-message";
    errorContainer.innerHTML = `
        <div class="error-message-content">
            <i class="fas fa-exclamation-triangle"></i>
            <div>
                <strong>Request failed:</strong>
                <p>${error || "An unknown error occurred."}</p>
            </div>
        </div>
        <div class="regenerate-container">
            <button class="button button-secondary error-regenerate-button">
                <i class="fas fa-sync-alt"></i>
                Try Again
            </button>
        </div>
    `;
    historyElement.appendChild(errorContainer);
    errorContainer
      .querySelector(".error-regenerate-button")
      .addEventListener("click", () => {
        vscode.postMessage({ command: "regenerate" });
      });
    scrollToBottom();
  }

  function showEmptyState() {
    historyElement.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-comments"></i>
        <h3>Start a conversation</h3>
        <p>Ask questions, request code, or get explanations. Your chat history will appear here.</p>
      </div>
    `;
  }

  function scrollToBottom() {
    historyElement.scrollTop = historyElement.scrollHeight;
  }

  showEmptyState();
  inputElement.focus();
})();
