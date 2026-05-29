# Sample Inputs

This directory contains example inputs for the Autotest extension — useful for demos, testing, and understanding the expected formats.

## Files

| File | Description |
|------|-------------|
| [prompts.md](./prompts.md) | Natural language prompts you can type into the extension to generate Playwright tests |
| [sample-recording.json](./sample-recording.json) | Example recorded test flow (JSON format as stored in chrome.storage) |
| [sample-spec.ts](./sample-spec.ts) | Example AI-generated Playwright .spec.ts test file |
| [sample-headless-config.json](./sample-headless-config.json) | Example configurations for headless Runner API calls |

## How to Use

### AI Generation Prompts
1. Open any website in Chrome
2. Click the Autotest extension icon
3. Copy a prompt from `prompts.md` into the AI prompt area
4. Click Send — the AI generates a complete Playwright test

### Sample Recording
The `sample-recording.json` shows the internal format of a recorded test. You can import this via the extension's import feature or use it as reference for understanding the step structure.

### Sample Spec File
The `sample-spec.ts` shows what the AI Generator produces. You can run it directly:
```bash
npx playwright test sample-inputs/sample-spec.ts
```

### Headless Configurations
The `sample-headless-config.json` shows various configurations for the Runner API, including:
- Basic Chromium desktop run
- Multi-browser parallel execution
- Mobile device emulation
- Full artifact capture (trace + video + HAR + screenshots)
- Geolocation spoofing
- Network mocking
