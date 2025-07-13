const vscode = require("vscode");
const { ChatViewProvider } = require("./src/ChatViewProvider");

function activate(context) {
  const provider = new ChatViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      provider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("llmChat.focus", () => {
      vscode.commands.executeCommand("llmChat.chatView.focus");
    })
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
