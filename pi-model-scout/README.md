# pi-model-scout

A [pi](https://pi.dev) package that automatically discovers models from OpenAI-compatible endpoints, so you don't have to list every model in `models.json` by hand.

Works with any server that implements `GET /v1/models`: **Unsloth Studio**, vLLM, SGLang, LM Studio, Ollama (`/v1`), LiteLLM, llama-server, and similar.

For **Unsloth Studio** it also discovers the *connected services* (OpenRouter, OpenAI, …) configured in Studio and exposes them as separate providers.

## Install

```bash
# from npm (after publishing)
pi install npm:pi-model-scout

# from git
pi install git:github.com/cobomi-lab/pi-model-scout@v0.1.0

# from a local checkout
pi install ./pi-model-scout

# try once without installing
pi -e ./pi-model-scout
```

## Configure

Add `"discoverModels": true` to any OpenAI-compatible provider in `~/.pi/agent/models.json` (or `$PI_CODING_AGENT_DIR/models.json`). You don't need a `models` array.

```json
{
  "providers": {
    "cobomi": {
      "baseUrl": "https://unsloth.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$UNSLOTH_API_KEY",
      "discoverModels": true,
      "contextWindow": 32768,
      "maxTokens": 8192,
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": false
      }
    },
    "vllm": {
      "baseUrl": "http://localhost:8000/v1",
      "apiKey": "none",
      "discoverModels": true
    }
  }
}
```

| Field | Required | Description |
|---|---|---|
| `discoverModels` | yes | Set to `true` to enable discovery for this provider. |
| `baseUrl` | yes | OpenAI-compatible base URL. It usually ends in `/v1`. |
| `apiKey` | no | Sent as `Authorization: Bearer …`. Accepts the same syntax as pi: `$VAR`, `${VAR}`, `!command`, or a literal value. |
| `api` | no | Pi API type. Default: `openai-completions`. |
| `headers` | no | Extra request headers (the same value syntax applies). |
| `compat` | no | Applied to every discovered model. |
| `contextWindow` | no | Context window to use when the server doesn't report one. Default: `32768` (local models) or `128000` (connected services). |
| `maxTokens` | no | Default output-token limit. Default: `8192`. |

`contextWindow` and `maxTokens` at the provider level are fields this extension adds; pi itself ignores them.

Then select a model with `/model`, or:

```bash
pi --list-models
pi --model cobomi/unsloth/Qwen3.8-27B-GGUF
```

## How it works

1. On startup the extension reads `models.json` and calls `GET {baseUrl}/models` for every provider with `discoverModels: true`.
2. It registers each provider with the discovered models through `pi.registerProvider()`. Requests use pi's built-in `openai-completions` streaming.
3. A `refreshModels` hook queries the server again whenever pi refreshes its catalog (for example, when you open `/model` or run `pi update --models`).

Each discovery request times out after 2 seconds, so an unreachable server delays startup by at most about 2 seconds. Discovery errors are shown as a pi notification once the session starts. In print/JSON mode, where there is no UI, they are written to stderr with the prefix `[pi-model-scout]`.
4. **Unsloth Studio only:** it also calls `GET {root}/api/providers/` (Unsloth's API path, not part of the OpenAI spec). Each enabled connected service becomes its own provider named `<provider>-<service>`, for example `cobomi-openrouter`. Requests for those models still go to Unsloth's `/v1/chat/completions` and carry extra body fields that tell Unsloth which service to forward them to (`provider_id`, `provider_type`, `external_model`). For servers other than Unsloth, this step quietly does nothing.

Context length is taken from `context_length` or `max_model_len` in the `/models` response, if present. Reasoning and image support are guessed from the model ID. To correct them, use pi's `modelOverrides` in `models.json`:

```json
{
  "providers": {
    "cobomi": {
      "modelOverrides": {
        "unsloth/Qwen3.8-27B-GGUF": { "contextWindow": 131072, "input": ["text", "image"] }
      }
    }
  }
}
```

## Commands

| Command | Description |
|---|---|
| `/scout-refresh` | Re-reads `models.json` and runs discovery again. This picks up providers you added or removed, new models, and newly connected Unsloth services without restarting pi. Shows a summary of the providers and model counts. If `models.json` can't be parsed, it reports the error and keeps the current providers. |

## Known limitations

- **Unsloth connected services must have a key saved for the API-key user.** Unsloth forwards the request using its saved key for that service. If it has none, you get errors such as `401 Failed to authenticate request with Clerk` (OpenRouter). Save the service key in Studio for the user that owns the API key. Alternatively, use pi's built-in provider directly (for example `/login openrouter`).
- All discovered models report a cost of 0.
- If a server can't be reached at startup, that provider has no models. A later catalog refresh or `/scout-refresh` retries.
- Embedding, audio, and image-generation models listed by `/models` are registered as chat models.

## Development

```bash
pi -e ./extensions/pi-model-scout.ts --list-models   # load without installing
```

Pi loads TypeScript directly, so no build step is needed. Pi provides `@earendil-works/pi-coding-agent` at runtime, so it is a `peerDependency`. It is also a `devDependency`, used only for type checking:

```bash
npm install
npm run typecheck
```

## Tasks (`just`)

A [`justfile`](justfile) wraps the common tasks. Run `just` to list them.

| Recipe | What it does |
|---|---|
| `just test` | Type check and run a smoke test against a fake `/v1/models` server. Your `~/.pi` config is not touched. |
| `just try` / `just models` | Run pi with the extension loaded from this checkout |
| `just install-local` / `just uninstall-local` | Add or remove this checkout in your pi install |
| `just check` | Check for leftover placeholders, run `test`, and preview the npm tarball |
| `just git-init <url>` | Initialise git, add the remote, make the first commit, and push |
| `just release-git [patch\|minor\|major]` | Run `check`, bump the version, then commit, tag and push |
| `just release [patch\|minor\|major]` | Same as `release-git`, then `npm publish` |

## Publish

```bash
npm pack --dry-run        # check tarball contents
npm publish               # or: npm publish --registry https://your.registry/
```

The `pi-package` keyword makes the package eligible for the [pi package gallery](https://pi.dev/packages).

## License

MIT
