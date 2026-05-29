# Natural Language Testing

Write tests in plain English. The AI parses your descriptions into executable steps with real DOM selectors, ready to replay immediately.

## How It Works

```
You type:  "Click the Sign In button, type admin@test.com in email, type secret in password, click Submit"
                                          │
                                          ▼
                    ┌──────────────────────────────────┐
                    │  Extension captures page context  │
                    │  (all visible elements + attrs)   │
                    └────────────────┬─────────────────┘
                                     │
                                     ▼
                    ┌──────────────────────────────────┐
                    │  Backend /api/v1/nlp/parse        │
                    │  1. Query ChromaDB for history    │
                    │  2. Build enriched LLM prompt     │
                    │  3. LLM returns structured steps  │
                    │  4. Validate against real DOM      │
                    └────────────────┬─────────────────┘
                                     │
                                     ▼
                    ┌──────────────────────────────────┐
                    │  Extension receives steps with    │
                    │  real selectors + fallbacks        │
                    │  → Stored as a recording           │
                    │  → Ready to replay                 │
                    └──────────────────────────────────┘
```

## Setup

### Option A: Backend AI (recommended)

1. Start the backend: `cd backend && docker compose up -d`
2. In extension Settings > **Generator** tab, set the Generator URL to `http://localhost:8002`
3. Click **Test Connection**
4. The backend handles all LLM calls with ChromaDB knowledge enrichment

### Option B: Browser-Only AI

If you don't want to run the backend, configure AI directly in the extension:

1. In extension Settings > **Generator** tab > AI in Browser
2. Select a provider (OpenAI or Anthropic Claude)
3. Enter your API key and select a model
4. Click **Test Connection**

## Writing NLP Tests

### Basic Usage

1. Navigate to the page you want to test
2. Click the Autotest extension icon
3. Type your test in the NLP text area
4. Click **Create NL Recording**
5. View the generated steps
6. Click **Replay All** to execute

### Syntax Guide

Write each action as a natural sentence. Multiple actions can go on separate lines or be combined with "and" / commas.

**Clicks:**
```
Click the "Sign In" button
Click on Login
Click the search icon
Click the first item in the list
```

**Text input:**
```
Type "john@example.com" in the email field
Enter "password123" in the password input
Type "hello world" in the search box
Clear the name field and type "New Name"
```

**Navigation:**
```
Go to the login page
Navigate to /dashboard
Open the settings page
```

**Form interactions:**
```
Select "United States" from the country dropdown
Check the "Remember me" checkbox
Uncheck the newsletter option
```

**Keyboard:**
```
Press Enter
Press Tab
Press Escape
```

**Assertions:**
```
Verify that "Welcome back" is visible
Check that the submit button is disabled
Assert the page title contains "Dashboard"
```

### Multi-Step Example

```
Navigate to the login page
Click on the email field
Type "admin@example.com"
Click on the password field
Type "secretpass"
Click the Submit button
Verify that "Welcome, Admin" is visible on the page
```

### Tips for Better Results

1. **Be specific about elements** -- "Click the blue Submit button at the bottom" is better than "Click submit"
2. **Reference visible text** -- Use the exact text you see on the page: `Click "Add to Cart"` (with quotes)
3. **Mention element types** -- "Click the **button** labeled Save" helps the AI narrow down candidates
4. **Use field labels** -- "Type in the **Email** field" works better than "Type in the first input"
5. **One action per line** -- Easier for the AI to parse correctly
6. **Avoid ambiguity** -- If there are multiple similar elements, add context: "Click the Delete button **next to John's row**"

## How Parsing Works

### Enhanced Parser (ReAct)

When page context is available, the enhanced parser uses a multi-step ReAct (Reason + Act) approach:

1. **Analyze** -- The AI receives your NL text plus a catalog of all visible DOM elements (tag, text, id, aria-label, placeholder, role, classes)
2. **Reason** -- The AI reasons about which elements match each action
3. **Act** -- It selects the best element and builds a primary CSS selector
4. **Validate** -- It verifies the selector matches exactly one element
5. **Fallbacks** -- Multiple fallback selectors are generated (id, aria-label, name, placeholder, role, XPath, text content) for resilience

### Selector Generation Strategy

For each element the AI identifies, the parser generates fallback selectors in this priority order:

| Priority | Strategy | Example |
|----------|----------|---------|
| 1 | ID | `#login-btn` |
| 2 | aria-label | `[aria-label="Login"]` |
| 3 | name attribute | `[name="email"]` |
| 4 | placeholder | `[placeholder="Enter email"]` |
| 5 | role attribute | `[role="button"]` |
| 6 | data-testid | `[data-testid="submit"]` |
| 7 | Tag + class | `button.btn-primary` |
| 8 | Tag + text (XPath) | `//button[contains(text(),'Submit')]` |
| 9 | Text content | `text=Submit` |

### Standard Parser (fallback)

When no page context is available or the enhanced parser fails, the standard parser:

1. Sends the NL text to the AI with a simpler prompt
2. AI returns action type + target descriptor
3. Steps are stored with descriptors only (selectors are resolved at replay time)

## Backend NLP Endpoint

When the backend is enabled, NLP requests go through `/api/v1/nlp/parse`:

```bash
curl -X POST http://localhost:8000/api/v1/nlp/parse \
  -H "Content-Type: application/json" \
  -d '{
    "nl_descriptions": [
      "Click the login button",
      "Type admin@test.com in the email field"
    ],
    "page_context": {
      "url": "https://example.com/login",
      "title": "Login Page",
      "elements": [
        { "tag": "button", "text": "Login", "id": "login-btn", "type": "button" },
        { "tag": "input", "placeholder": "Email", "name": "email", "type": "email" }
      ]
    },
    "source_url": "https://example.com/login"
  }'
```

The backend enriches the prompt with historical knowledge from ChromaDB:
- Previously successful selectors for similar elements on this page
- Action sequences that worked for similar goals
- Page structure patterns

This means the system gets more accurate the more you use it.

## AI Provider Comparison

| Provider | Speed | Accuracy | Cost | Privacy |
|----------|-------|----------|------|---------|
| **GPT-4o** | Fast | Excellent | ~$2.50/1M input | Cloud |
| **GPT-4o Mini** | Very fast | Good | ~$0.15/1M input | Cloud |
| **Claude 3.5 Sonnet** | Fast | Excellent | ~$3/1M input | Cloud |
| **Claude 3.5 Haiku** | Very fast | Good | ~$1/1M input | Cloud |

**Recommendations:**
- For best accuracy: GPT-4o or Claude 3.5 Sonnet
- For speed + cost balance: GPT-4o Mini or Claude 3.5 Haiku

## NLP Replay Options

In Settings > **Generator** tab > NLP Replay Options:

| Option | Default | Description |
|--------|---------|-------------|
| **Use AI during replay** | Off | When on, AI is used as a fallback to find elements if text matching fails during replay. Slower but more accurate. |
| **Enhanced Parsing (ReAct)** | On | Use multi-step reasoning during NLP parsing. Generates more precise selectors upfront. |

## Troubleshooting

### "No elements found" or wrong element matched

- Make sure you're on the correct page when creating the NL recording
- The extension captures the page's current DOM state -- wait for the page to fully load
- Try being more specific: use exact visible text, mention the element type
- Check the backend logs for the full LLM prompt and response: `docker compose logs -f backend`

### AI provider errors

- Verify your API key is valid and has credits
- Check Settings > AI & Backend > Test Connection
- For Claude CLI: run `claude auth status` to verify your session is active

### Steps generated but replay fails

- Open the recording in Settings > Recordings, click **Edit** on the failing step
- Check the primary selector and fallbacks
- The AI may have picked the wrong element -- edit the selector manually
- Re-run the same NLP command -- ChromaDB learns from failures and improves

### Slow parsing

- Large pages with many elements take longer (the full element catalog is sent to the LLM)
- Switch to a faster model (GPT-4o Mini, Claude 3.5 Haiku)
- Enable Enhanced Parsing (ReAct) for better first-attempt accuracy, reducing retries
