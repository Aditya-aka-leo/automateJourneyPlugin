# Recording & Replay

Record user interactions in Chrome and replay them across environments with self-healing selectors, real-time HUD visualization, and screenshot/video capture.

## Recording

### Start a Recording

1. Navigate to your web application
2. Click the Autotest extension icon
3. Click **Start Recording** -- the badge shows an animated "REC" indicator
4. Interact with the page normally
5. Click **Stop Recording** and enter a name

### What Gets Captured

| Event | Captured As | Details |
|-------|------------|---------|
| Click | `click` step | Selector + element name + coordinates |
| Text input | `input` step | Selector + typed value (debounced -- continuous typing merges into one step) |
| Select/dropdown change | `change` step | Selector + selected value |
| Form submission | `submit` step | Selector of the form or submit button |
| Page navigation | `navigation` step | Relative path + query params (relative to environment base URL) |

### Smart Recording Features

**Input merging** -- When you type into a field, keystrokes are debounced with a 1-second window. Typing "hello world" produces one `input` step, not 11 keystrokes.

**Relative URLs** -- Navigation steps store relative paths (`/login`, `/dashboard?tab=settings`) instead of full URLs. This allows the same recording to replay on any environment.

**Element names** -- Each step captures a human-readable name from the element's `aria-label`, `placeholder`, `name`, `title`, `data-testid`, or `id`. This makes step lists readable (e.g. "CLICK: Submit Order" instead of "CLICK: button.btn-primary").

**Multi-selector fallbacks** -- Each step generates multiple selectors for resilience (see Selector Strategy below).

### Adding Assertions During Recording

While recording, click the **Assert** button in the popup to add an assertion at the current point. Assertions verify that the page is in the expected state:

- **Element exists / is visible** -- Checks that a specific element is present
- **Text equals / contains** -- Verifies text content
- **Attribute equals** -- Checks an element attribute value
- **URL contains** -- Verifies the current URL
- **Element is checked / disabled / enabled / editable** -- State checks

Assertions are saved as steps in the recording and verified during replay.

## Replay

### Basic Replay

1. Click the extension icon
2. Select an **environment** from the dropdown (determines the base URL)
3. Select a **recording** from the dropdown
4. Click **Replay All**

### Replay Controls

| Control | Location | Description |
|---------|----------|-------------|
| **Replay All** | Popup toolbar | Run all steps from the beginning |
| **Replay Partial** | Popup toolbar | Run from a specific step |
| **Pause** | Popup / HUD | Pause execution between steps |
| **Resume** | Popup / HUD | Continue after pausing |
| **Stop** | Popup | Abort the replay |

### HUD (Heads-Up Display)

Enable **Show HUD** before replaying. The HUD is an overlay injected into the page that shows:

- All steps grouped by page with color coding
- Real-time status for each step (pending, running, passed, failed)
- Element names and relative URLs
- Pause button per step (pause before that step executes)
- Edit button per step (re-record that specific step)
- Auto-scrolls to the currently executing step
- Persists across page navigations

### Multi-Environment Replay

Record a flow once, then replay it on any environment:

1. In Settings > **Basic** tab > Environments, add multiple environments:
   - "Dev" with base URL `https://dev.example.com`
   - "Staging" with base URL `https://staging.example.com`
   - "Production" with base URL `https://example.com`
2. Record a flow on any environment
3. Switch the environment dropdown in the popup
4. Click **Replay All** -- the same steps execute against the new base URL

Environment variables (`${VAR}` or `{{VAR}}`) in step values are resolved from the selected environment's variable table.

### Replay Settings

In Settings > **Basic** tab > Replay Settings:

| Setting | Default | Description |
|---------|---------|-------------|
| **Default retry count** | 0 | Number of times to retry a failed step (0 = no retries) |
| **Soft assertions** | Off | Log assertion failures without stopping the test |
| **Viewport override** | (none) | Force a specific viewport size during replay |

## Selector Strategy

Each recorded step generates multiple selectors, tried in order during replay:

| Priority | Type | Example | Reliability |
|----------|------|---------|-------------|
| 1 | CSS ID | `#submit-btn` | High (if stable) |
| 2 | data-testid | `[data-testid="login-form"]` | High |
| 3 | aria-label | `[aria-label="Search"]` | High |
| 4 | name attribute | `[name="email"]` | Medium-High |
| 5 | placeholder | `[placeholder="Enter email"]` | Medium |
| 6 | role + text | `[role="button"]` | Medium |
| 7 | XPath | `//button[text()='Submit']` | Medium |
| 8 | CSS path | `form > div:nth-child(2) > button` | Low (fragile) |

Each selector is stored with:
- `type` -- css, xpath, text, role, label, placeholder
- `value` -- the selector string
- `reason` -- why this selector was chosen
- `matchIndex` -- which match to use if multiple elements match
- `matchCount` -- how many elements matched at recording time

### Self-Healing

When the primary selector fails during replay, the self-healing system kicks in:

1. **Fallback selectors** -- Try each fallback in order until one finds a visible element
2. **Text matching** -- Search for elements with matching visible text
3. **AI refinement** -- If all fallbacks fail and the backend is enabled, request multi-hop AI refinement:
   - Send failed selectors + candidate elements + page context to the backend
   - Backend queries ChromaDB for historically successful selectors
   - Backend asks the LLM for refined alternatives
   - Extension tries the refined selectors
   - Loop up to 3 times

Every outcome (success or failure) is reported to ChromaDB so the system learns over time.

## Screenshot & Video Capture

Configure in Settings > **Basic** tab > Screenshot & Video Capture.

### Capture Modes

| Mode | Description |
|------|-------------|
| **None** | No capture |
| **Screenshots Only** | Take a screenshot after each step |
| **Video Only** | Record the full replay session as WebM video |
| **Both** | Screenshots + video |

### Capture on Failure Only

When enabled, screenshots/video are only captured when a step fails. This saves storage for successful runs.

### Viewing Captures

After replay, screenshots appear inline in the step results. Video files can be downloaded from the report.

> Note: Extension-based video recording has browser limitations. For reliable video capture, use the [Playwright Runner](./playwright-runner.md).

## Exporting to Playwright

Recordings can be exported as standalone Playwright test code:

1. Select a recording in the popup
2. Click the **Export** button
3. The generated `.spec.ts` file includes:
   - Base URL from environment variables (`process.env.APP_BASE_URL`)
   - A reusable selector map
   - A locator resolver with fallback support
   - Assertions translated to Playwright's `expect()` API

This lets you integrate Autotest recordings into your existing Playwright test suite.

## Badge Indicators

The extension icon badge shows the current state:

| Badge | Color | Meaning |
|-------|-------|---------|
| Animated "REC" | Red | Recording in progress |
| "3/10" | Blue | Replaying step 3 of 10 |
| Checkmark | Green | Last replay succeeded |
| X | Red | Last replay failed |

Success/failure status persists for 24 hours per website.

## Editing Steps

### In the Popup

Click a step in the step list to see its details. Steps show their type, element name, and value.

### In the HUD

Click the pencil icon next to any step to re-record it. The HUD enters edit mode, captures your next interaction, and replaces that step.

### In Settings > Recordings

1. Go to Settings > Recordings tab
2. Find your recording and click **Edit** on any step
3. The step editor lets you modify:
   - Step type (click, input, navigation, etc.)
   - Custom step name
   - Value
   - Primary selector (type, value, match index)
   - Fallback selectors (add, remove, reorder)
   - Relative path and query parameters

## Storage

Recordings are stored in `chrome.storage.local` via a versioned store. Each recording contains:

```json
{
  "id": "rec_abc123",
  "name": "Login Flow",
  "createdAt": "2026-02-10T10:30:00Z",
  "updatedAt": "2026-02-12T14:00:00Z",
  "steps": [
    {
      "type": "navigation",
      "relativePath": "/login",
      "envId": "env-uuid",
      "timestamp": 1707560000000
    },
    {
      "type": "input",
      "selector": {
        "primary": { "type": "css", "value": "#email", "matchIndex": 0, "matchCount": 1 },
        "fallbacks": [
          { "type": "css", "value": "[name='email']" },
          { "type": "css", "value": "[placeholder='Enter email']" }
        ]
      },
      "value": "user@test.com",
      "elementName": "Email",
      "relativePath": "/login",
      "envId": "env-uuid",
      "timestamp": 1707560001000
    }
  ]
}
```

## Troubleshooting

### Recording not starting

- Make sure you're on an HTTP/HTTPS page (not `chrome://`, `about:`, or `file://` pages)
- Reload the extension at `chrome://extensions`
- Check the popup console (right-click icon > Inspect) for errors

### Steps not replaying correctly

- Verify the correct environment is selected
- Check that the base URL is correct and the site is accessible
- Try pausing and stepping through to identify which step fails
- Edit the failing step's selector if the DOM has changed
- Enable the backend for AI-powered self-healing

### HUD not showing

- Make sure **Show HUD** is enabled in the popup
- The HUD cannot be injected into `chrome://` or extension pages
- Try refreshing the target page

### Replay badge stuck

- Click the extension icon to check the current state
- If stuck in "replaying" mode, click **Stop** to reset
- Reload the extension if controls are unresponsive
