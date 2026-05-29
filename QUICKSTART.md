# Autotest QA Extension — Quickstart Guide

**Version:** 0.1.0
**Backend:** http://no1010042033158.corp.adobe.com:8000
**Test credentials:** test1@gmail.com / test

---

## Table of Contents

1. [Install the Extension](#1-install-the-extension)
2. [Open the Extension](#2-open-the-extension)
3. [Connect to the Backend](#3-connect-to-the-backend)
4. [Feature 1 — Record](#4-feature-1--record)
5. [Feature 2 — Replay](#5-feature-2--replay)
6. [Feature 3 — Generate (AI)](#6-feature-3--generate-ai)
7. [Feature 4 — Headless Runner](#7-feature-4--headless-runner)

---

## 1. Install the Extension

### Step 1 — Unzip

Unzip the provided `autotest-extension.zip` to any permanent folder on your machine.
**Do not delete this folder** — Chrome loads the extension directly from it.

```
autotest-extension/
├── manifest.json
├── background/
├── popup/
├── sidepanel/
├── options/
└── icons/
```

> 📸 **Screenshot here:** Unzipped folder contents in Finder/Explorer

---

### Step 2 — Open Chrome Extensions

Open Google Chrome and navigate to:

```
chrome://extensions
```

Or go to **⋮ Menu → Extensions → Manage Extensions**.

> 📸 **Screenshot here:** Chrome Extensions page (chrome://extensions)

---

### Step 3 — Enable Developer Mode

In the top-right corner of the Extensions page, toggle **Developer mode** ON.

> 📸 **Screenshot here:** Developer mode toggle switched ON (top-right)

---

### Step 4 — Load the Extension

Click **"Load unpacked"** (appears after enabling Developer mode).

Navigate to and select the **unzipped `autotest-extension` folder** (the one containing `manifest.json`).

Click **Select / Open**.

> 📸 **Screenshot here:** Load unpacked dialog with the folder selected

---

### Step 5 — Confirm Installation

The **Autotest - QA Automation** card should appear in your extensions list.
Pin it to your toolbar by clicking the puzzle piece icon (🧩) → pin Autotest.

> 📸 **Screenshot here:** Autotest extension card in chrome://extensions
> 📸 **Screenshot here:** Autotest icon pinned in Chrome toolbar

---

## 2. Open the Extension

There are two ways to use the extension:

| Mode | How to open | Best for |
|------|-------------|----------|
| **Side Panel** | Click the Autotest icon in toolbar → click the side-panel icon (□▷) | Working alongside a page |
| **Popup** | Click the Autotest icon in toolbar | Quick actions |

> 📸 **Screenshot here:** Extension popup opened showing the 4 home buttons

The **home screen** shows four large buttons:

```
┌─────────────┬──────────────┐
│  ⏺  Record  │  ✨ Generate │
├─────────────┼──────────────┤
│  ▶  Replay  │  🖥 Headless │
└─────────────┴──────────────┘
```

> **Note:** Generate and Headless are greyed out until you connect to the backend (next step).

---

## 3. Connect to the Backend

### Step 1 — Open Settings

Click the **⚙ gear icon** (top-right of the extension) to open Settings, then go to the **Advanced** tab.

> 📸 **Screenshot here:** Settings page with Advanced tab selected

---

### Step 2 — Enter Backend URL

Scroll to the **Backend Connection** section.
In the **Backend URL** field enter:

```
http://no1010042033158.corp.adobe.com:8000
```

> 📸 **Screenshot here:** Backend URL field filled in

---

### Step 3 — Log In

Enter the credentials:

| Field | Value |
|-------|-------|
| Email | `test1@gmail.com` |
| Password | `test` |

Click **Login**.

> 📸 **Screenshot here:** Email and password fields filled, before clicking Login

---

### Step 4 — Confirm Connection

On success you will see a green status bar showing:

```
● Connected  |  user: test1@gmail.com  |  project: <project name>
```

> 📸 **Screenshot here:** Green connected status with user and project info

Close Settings. Back on the home screen, all four buttons are now active.

> 📸 **Screenshot here:** Home screen with all 4 buttons active (no grey-out)

---

## 4. Feature 1 — Record

**What it does:** Captures every click, input, and navigation you perform on a live page and saves it as a replayable test recording.

### Steps

1. Navigate to the page you want to test (e.g. `https://demowebshop.tricentis.com/`).

2. Click **⏺ Record** on the home screen.
   A red recording indicator appears at the top of the page.

   > 📸 **Screenshot here:** Page with red recording HUD bar active at top

3. Perform your test steps on the page — click buttons, fill forms, navigate.
   Each action is captured and listed in the extension panel.

   > 📸 **Screenshot here:** Extension showing list of captured steps during recording

4. Click **■ Stop** when done.

5. Give the recording a name and click **Save**.

   > 📸 **Screenshot here:** Save recording dialog with name field

6. The recording now appears in the **Recording** dropdown for Replay.

   > 📸 **Screenshot here:** Recording dropdown showing the saved recording

---

## 5. Feature 2 — Replay

**What it does:** Re-executes a saved recording step-by-step in the current browser tab, with optional screenshot/video capture.

### Steps

1. Navigate to the same base URL where the recording was made.

2. Click **▶ Replay** on the home screen.

3. From the **Environment** dropdown, select the target environment (URL).
   From the **Recording** dropdown, select the recording you saved.

   > 📸 **Screenshot here:** Replay panel with environment and recording selected

4. Optionally set capture mode using the strip at the bottom:
   - **Off** — no screenshots
   - **📷 Photo** — screenshots at each step
   - **🎬 Video** — full video
   - **Both** — screenshots + video

5. Click **▶ Run**.
   Steps execute one by one; each step shows ✓ pass or ✗ fail in real-time.

   > 📸 **Screenshot here:** Replay running with step-by-step green checkmarks

6. After completion, a summary shows passed/failed counts and any captured artifacts.

   > 📸 **Screenshot here:** Replay completion summary with pass/fail counts

---

## 6. Feature 3 — Generate (AI)

**What it does:** Uses Claude AI to write a Playwright `.spec.ts` test from a plain English description of what you want to test.

### Steps

1. Navigate to the page you want to generate a test for.

2. Click **✨ Generate** on the home screen.

3. The AI prompt area appears. Type a description of your test scenario, for example:
   ```
   Test the login flow with valid and invalid credentials
   ```

   > 📸 **Screenshot here:** AI prompt section with example description typed in

4. Choose a generation mode using the toggle below the hint chips:
   - **⚡ Fast** — Claude writes the test immediately from your description (~10-15 sec)
   - **🔬 Reasoning** — Claude opens the live page, inspects it, generates, then validates and auto-fixes the test (~3-8 min)

   > 📸 **Screenshot here:** Fast/Reasoning toggle with Fast selected (purple)

5. Click the **➤ Send** button.

6. Watch live progress in the status area:
   - Fast mode: `Generating...` → `Done ✓`
   - Reasoning mode: `Generating...` → `Validating...` → `Fix attempt 1/3...` → `Validated ✓`

   > 📸 **Screenshot here:** Generation in progress showing phase label and elapsed timer

7. When complete, the generated test code is shown in a preview card with step count and elapsed time.

   > 📸 **Screenshot here:** Generation result card showing test name, step count, and code preview

8. The test is automatically saved to the backend and available in the Recording dropdown for Headless execution.

---

## 7. Feature 4 — Headless Runner

**What it does:** Executes a Playwright `.spec.ts` test in a real headless browser (Chromium, Firefox, or WebKit) on the backend server, and returns screenshots, video, and a HAR network log.

### Steps

1. Click **🖥 Headless** on the home screen.

2. The Playwright Runner panel opens. From the **Recording** dropdown, select the test you recorded or AI-generated.

   > 📸 **Screenshot here:** Headless panel with recording dropdown open

3. Configure options:
   - **Browser:** Chromium (default), Firefox, WebKit
   - **Screenshots:** on/off
   - **Video:** on/off
   - **Trace:** on/off (enables Playwright trace viewer)

   > 📸 **Screenshot here:** Headless options panel with browser and capture settings

4. Click **▶ Run Headless**.
   The backend executes the test and streams live progress back.

   > 📸 **Screenshot here:** Headless test running with live step progress

5. After completion, the results panel shows:
   - ✓ / ✗ per test case
   - Total passed / failed / duration
   - Artifact links: **Screenshots**, **Video**, **Trace**, **HAR**

   > 📸 **Screenshot here:** Headless results with passed tests and artifact download links

6. Click any screenshot thumbnail to view it enlarged.
   Click **Trace** to open the Playwright Trace Viewer for step-by-step debugging.

   > 📸 **Screenshot here:** Screenshot lightbox / trace viewer open

---

## Quick Reference

| Feature | Requires Login | Time | Output |
|---------|---------------|------|--------|
| Record | No | Real-time | Saved recording |
| Replay | No | Real-time | Pass/fail per step |
| Generate (Fast) | Yes | ~15 sec | `.spec.ts` test file |
| Generate (Reasoning) | Yes | ~3-8 min | Validated `.spec.ts` |
| Headless Runner | Yes | ~30-120 sec | Report + screenshots/video/trace |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Generate / Headless buttons greyed out | Log in via Settings → Advanced |
| "Generation failed — Claude exited code 1" | Check model in Settings → Advanced → AI Config (should be `claude-opus-4-6`) |
| "Failed to connect to Claude proxy" | Confirm backend is reachable: open `http://no1010042033158.corp.adobe.com:8000/health` in browser |
| Recording not in dropdown | Refresh the extension (click away and back to Replay mode) |
| Headless test times out | The target site may be slow — try again or switch to a faster model |
