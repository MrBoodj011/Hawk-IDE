# Hawk LLM configuration

Hawk is BYOK and local-first. It does not ship an OpenAI, Anthropic, Google,
OpenRouter, Groq, DeepSeek, Moonshot, or other provider credential. Use only a
key owned by the operator and allowed for the selected project.

## IDE secret vault

Run **Hawk: Configure AI Provider and API Key**. Select the provider, optional
model, and endpoint, then enter the key. Hawk stores hosted keys under a
provider-specific entry in VS Code SecretStorage. Only the extension host can
read that value; it injects the current provider's key into the local daemon
process as `HAWK_IDE_API_KEY`. The worker inherits it in memory, while Hawk
excludes it from settings, config files, prompts, task events, debug bundles,
and Git.

Use **Hawk: Show AI Provider Status** to inspect provider/model/endpoint and
whether a credential exists without revealing it. Use **Hawk: Remove Current
AI Provider Key** to delete the current hosted-provider secret.

Remote custom endpoints require HTTPS. Ollama and LM Studio HTTP endpoints are
restricted to `localhost`, `127.0.0.1`, or `::1`.

## CLI environment variables

The standalone CLI also supports local environment variables:

| Provider | Environment variable |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Groq | `GROQ_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Kimi / Moonshot | `MOONSHOT_API_KEY` or `KIMI_API_KEY` |

Do not commit `.env` files. Hawk can also reference an explicit environment
variable name through `api_key_env`, which keeps the credential value out of
`~/.hawk/config.json`.
