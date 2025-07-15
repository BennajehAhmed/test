const vscode = require("vscode");
const { getSystemPrompt } = require("./systemPrompt");

async function getChatCompletion(messages, openDocs) {
  // const systemPrompt = getSystemPrompt(openDocs);

  // 🔽 Get model from user settings
  const config = vscode.workspace.getConfiguration("llm-chat");
  const selectedModel = config.get(
    "model",
    "deepseek-ai/DeepSeek-V3-0324-Turbo"
  ); // fallback default

  const requestBody = {
    model: selectedModel,
    messages,
    stream: false,
  };

  try {
    const response = await fetch(
      "https://api.deepinfra.com/v1/openai/chat/completions",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-deepinfra-source": "web-embed",
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    console.error("Error fetching chat completion:", error);
    throw error;
  }
}

module.exports = {
  getChatCompletion,
};
