# Plugin Feature Comparison Matrix

Use this document to compare Autotest with another similar plugin.

- `This Plugin (Autotest)`: current capability and behavior.
- `Other Plugin`: fill after reviewing the competing plugin.
- `Final Consolidated Feature`: define the merged target feature you want to keep or build.

## Major Categories

1. Recording
2. Replay and Selector Recovery
3. UI (HUD / Side Panel / Popup)
4. Edit Steps
5. AI and Natural Language
6. Playwright and Reporting
7. Media Capture
8. Environments and Settings

## Recording

| ID | Minor Category | Itemized Feature | This Plugin (Autotest) | Other Plugin | Final Consolidated Feature |
|---|---|---|---|---|---|
| REC-01 | Events Captured | Click events | Yes, records click interactions as replayable steps | TBD | Keep click capture as baseline |
| REC-02 | Events Captured | Text input events | Yes, records text entry and input changes | TBD | Keep text input capture |
| REC-03 | Events Captured | Form field changes | Yes, records form updates and changes | TBD | Keep form-change capture |
| REC-04 | Events Captured | Page navigation | Yes, records navigation transitions | TBD | Keep navigation capture |
| REC-05 | Events Captured | Form submission | Yes, records submit actions | TBD | Keep submit capture |
| REC-06 | Input Handling | Typing debounce / merge | Yes, continuous typing is merged into a single step | TBD | Keep debounce; improve only if competitor is better |
| REC-07 | Portability | Relative-path storage | Yes, saves relative paths for multi-environment replay | TBD | Keep relative-path strategy |
| REC-08 | Step Metadata | Human-readable step labels | Yes, derives names from aria-label, placeholder, name, and id | TBD | Keep readable labels and extend if useful |

## Replay and Selector Recovery

| ID | Minor Category | Itemized Feature | This Plugin (Autotest) | Other Plugin | Final Consolidated Feature |
|---|---|---|---|---|---|
| REP-01 | Execution | Step-by-step replay | Yes, replays recorded steps in sequence | TBD | Keep deterministic step replay |
| REP-02 | Execution | Live replay progress | Yes, shows current replay progress live | TBD | Keep live progress feedback |
| REP-03 | Execution | Auto-open target page | Yes, opens the correct URL in a new tab | TBD | Keep auto-open behavior |
| REP-04 | Controls | Pause replay | Yes | TBD | Keep pause control |
| REP-05 | Controls | Resume replay | Yes | TBD | Keep resume control |
| REP-06 | Controls | Stop replay | Yes | TBD | Keep stop control |
| REP-07 | Reliability | Retry mode | Yes, configurable retry support exists | TBD | Keep retry mode |
| REP-08 | Reliability | Soft assertion mode | Yes, supports soft assertions | TBD | Keep soft assertions |
| REP-09 | Portability | Replay across environments | Yes, same recording can run against different base URLs | TBD | Keep cross-environment replay |
| REP-10 | Selector Strategy | CSS ID selector | Yes, uses `#id` when available | TBD | Keep as first selector priority |
| REP-11 | Selector Strategy | `data-testid` selector | Yes, uses `[data-testid="..."]` fallback | TBD | Keep as high-priority fallback |
| REP-12 | Selector Strategy | `aria-label` selector | Yes, uses accessibility labels as fallback | TBD | Keep accessibility-based selector support |
| REP-13 | Selector Strategy | Role + text selector | Yes, uses semantic role and text matching | TBD | Keep semantic selector fallback |
| REP-14 | Selector Strategy | XPath fallback | Yes, uses XPath as last-resort selector | TBD | Keep as final deterministic fallback |
| REP-15 | Selector Strategy | Multi-selector storage | Yes, stores multiple selector strategies per step | TBD | Keep multi-selector storage |
| REP-16 | Self-Healing | Selector fallback chain | Yes, tries multiple selectors in order | TBD | Keep fallback chain |
| REP-17 | Self-Healing | AI selector refinement | Yes, asks backend AI to recover broken selectors | TBD | Keep AI refinement flow |
| REP-18 | Self-Healing | Recovery trigger after selector failure | Yes, healing starts after selector exhaustion | TBD | Keep failure-triggered recovery |

## UI (HUD / Side Panel / Popup)

| ID | Minor Category | Itemized Feature | This Plugin (Autotest) | Other Plugin | Final Consolidated Feature |
|---|---|---|---|---|---|
| UI-01 | HUD | Scrollable step list | Yes, full scrollable overlay list is shown on page | TBD | Keep scrollable HUD |
| UI-02 | HUD | Live step status indicators | Yes, step-level live status badges are shown | TBD | Keep live status indicators |
| UI-03 | HUD | Page-grouped step view | Yes, steps are grouped by page | TBD | Keep page grouping |
| UI-04 | HUD | Color-coded states | Yes, uses color-coded step states | TBD | Keep color semantics |
| UI-05 | HUD | Pause before a selected step | Yes | TBD | Keep pause-before-step control |
| UI-06 | HUD | Persistence across navigation | Yes, HUD persists across page transitions | TBD | Keep persistent HUD behavior |
| UI-07 | Side Panel / Sidebar | Dedicated side panel mode | Yes, separate side panel UI exists | TBD | Keep persistent side panel mode |
| UI-08 | Side Panel / Sidebar | Pin to side panel toggle | Yes, popup has an explicit `Pin to Side Panel` control | TBD | Keep one-click side panel toggle |
| UI-09 | Popup | Popup entry UI | Yes, popup provides primary extension controls | TBD | Keep popup as quick-launch surface |
| UI-10 | Overlay Modes | HUD / side panel mode switch | Yes, overlay mode buttons switch between HUD and side panel | TBD | Keep explicit overlay mode switch |
| UI-11 | Navigation Controls | Environment selector in UI | Yes, popup/side panel includes environment selector | TBD | Keep inline environment selection |
| UI-12 | Navigation Controls | Recording selector in UI | Yes, popup/side panel includes recording selector | TBD | Keep inline recording selection |
| UI-13 | Status | Global status bar | Yes, UI shows idle/running status bar | TBD | Keep visible global status |
| UI-14 | Settings Access | Settings shortcut | Yes, popup header includes direct settings button | TBD | Keep direct settings access |
| UI-15 | Indicators | Recording indicator | Yes, animated `REC` indicator is documented | TBD | Keep recording indicator |
| UI-16 | Indicators | Replay step counter | Yes, shows `current/total` progress | TBD | Keep step counter |
| UI-17 | Indicators | Success indicator | Yes, success checkmark shown | TBD | Keep success status |
| UI-18 | Indicators | Failure indicator | Yes, failure state shown with red X | TBD | Keep failure status |

## Edit Steps

| ID | Minor Category | Itemized Feature | This Plugin (Autotest) | Other Plugin | Final Consolidated Feature |
|---|---|---|---|---|---|
| EDT-01 | Editing Workflow | Inline step editing | Yes, a step can be edited inline from the UI | TBD | Keep inline editing workflow |
| EDT-02 | Editing Workflow | Re-record specific step | Yes, a step can be re-recorded | TBD | Keep targeted step re-recording |
| EDT-03 | Editor Fields | Custom step name | Yes, editor supports custom step name | TBD | Keep editable display names |
| EDT-04 | Editor Fields | Step type selector | Yes, editor supports changing the step type | TBD | Keep editable step types |
| EDT-05 | Editor Fields | Value field | Yes, editor supports editing step value | TBD | Keep editable value field |
| EDT-06 | Editor Fields | Selector field | Yes, editor supports editing CSS selector or XPath | TBD | Keep editable selector field |
| EDT-07 | Editor Fields | Attribute field | Yes, editor supports attribute input for attribute assertions | TBD | Keep dedicated attribute field |
| EDT-08 | Editor Fields | Timeout override | Yes, editor supports per-step timeout in ms | TBD | Keep per-step timeout override |
| EDT-09 | Editor Fields | Per-step soft assertion | Yes, assertion steps can enable `Continue on failure` | TBD | Keep per-step soft assertion toggle |
| EDT-10 | Editor Actions | Save step changes | Yes | TBD | Keep explicit save action |
| EDT-11 | Editor Actions | Delete step | Yes | TBD | Keep step deletion |
| EDT-12 | Editor Actions | Cancel / close editor | Yes | TBD | Keep cancel and close actions |
| EDT-13 | Step Types | Action step types | Yes, editor includes click, input, change, submit, navigation, scroll, select, hover, keyboard, upload, and drag-drop | TBD | Keep broad action-step coverage |
| EDT-14 | Step Types | Assertion step types | Yes, editor includes element, text, attribute, URL, checked, disabled, enabled, class, value, title, count, editable, console-error, and screenshot assertions | TBD | Keep broad assertion coverage |
| EDT-15 | Step Types | Wait step types | Yes, editor includes delay, URL, text, element, and navigation waits | TBD | Keep wait-step coverage |
| EDT-16 | Step Types | Control-flow step types | Yes, editor includes conditional and loop controls | TBD | Keep control-flow editing support |

## AI and Natural Language

| ID | Minor Category | Itemized Feature | This Plugin (Autotest) | Other Plugin | Final Consolidated Feature |
|---|---|---|---|---|---|
| AI-01 | Authoring | Plain-English test authoring | Yes, tests can be written in plain English | TBD | Keep NL authoring |
| AI-02 | Providers | OpenAI support | Yes | TBD | Keep provider support |
| AI-03 | Providers | Anthropic Claude support | Yes | TBD | Keep provider support |
| AI-04 | Providers | Claude CLI support | Yes, uses Claude CLI with OAuth login | TBD | Keep CLI-based provider |
| AI-05 | Parsing | Parse text into executable steps | Yes, NL is converted to structured executable steps | TBD | Keep structured parse pipeline |
| AI-06 | Parsing | DOM-grounded selector generation | Yes, generated steps include selectors from page context | TBD | Keep DOM grounding |
| AI-07 | Parsing | Enhanced multi-step parser | Yes | TBD | Keep enhanced parser |
| AI-08 | Reasoning | ReAct-style reasoning | Yes, enhanced parser uses ReAct-style reasoning | TBD | Keep reasoning-based parse flow |
| AI-09 | Runtime Mode | Browser-only AI mode | Yes, direct AI calls can run in extension | TBD | Keep lightweight browser-only mode |
| AI-10 | Runtime Mode | Backend AI mode | Yes, backend orchestration is supported | TBD | Keep advanced backend mode |
| AI-11 | Governance | Global AI disable switch | Yes, all AI can be disabled | TBD | Keep AI master switch |
| AI-12 | Learning | ChromaDB-backed learning | Yes, backend learning with ChromaDB is supported | TBD | Keep optional learning integration |
| AI-13 | Orchestration | Multi-page backend orchestration | Yes, backend mode supports multi-page orchestration | TBD | Keep multi-page orchestration where useful |
| AI-14 | Recovery | AI-assisted selector healing | Yes, AI helps recover broken selectors during replay | TBD | Keep AI recovery loop |

## Playwright and Reporting

| ID | Minor Category | Itemized Feature | This Plugin (Autotest) | Other Plugin | Final Consolidated Feature |
|---|---|---|---|---|---|
| PW-01 | Execution | Headless execution handoff | Yes, recordings can be sent to Playwright runner | TBD | Keep runner handoff |
| PW-02 | Browsers | Chromium support | Yes | TBD | Keep Chromium support |
| PW-03 | Browsers | Firefox support | Yes | TBD | Keep Firefox support |
| PW-04 | Browsers | WebKit support | Yes | TBD | Keep WebKit support |
| PW-05 | Device Profiles | Device emulation | Yes, runner UI supports device selection | TBD | Keep device emulation |
| PW-06 | Artifacts | Detailed per-step report | Yes | TBD | Keep detailed reports |
| PW-07 | Artifacts | Trace files | Yes | TBD | Keep tracing support |
| PW-08 | Artifacts | Video artifacts | Yes | TBD | Keep video artifacts |
| PW-09 | Artifacts | HAR logs | Yes | TBD | Keep HAR generation |
| PW-10 | Artifacts | Screenshots in reports | Yes | TBD | Keep screenshot artifacts |
| PW-11 | Advanced Config | Timezone override | Yes, runner UI supports custom timezone | TBD | Keep timezone override |
| PW-12 | Advanced Config | Locale override | Yes, runner UI supports custom locale | TBD | Keep locale override |
| PW-13 | Advanced Config | Geolocation override | Yes, runner UI supports latitude and longitude fields | TBD | Keep geolocation override |
| PW-14 | Advanced Config | Network mocks | Yes, runner UI supports network mocks JSON | TBD | Keep network mocking |
| PW-15 | Operations | Run all recordings sequentially | Yes, UI includes `Run all` control | TBD | Keep batch run capability |
| PW-16 | Operations | Save storage state | Yes, UI includes auth/session state save control | TBD | Keep session-state reuse |
| PW-17 | Export | Export recording to Playwright code | Yes, recordings can be exported as Playwright test scripts | TBD | Keep code export pathway |
| PW-18 | Reporting | View last test report | Yes, UI includes report access action | TBD | Keep quick report access |

## Media Capture

| ID | Minor Category | Itemized Feature | This Plugin (Autotest) | Other Plugin | Final Consolidated Feature |
|---|---|---|---|---|---|
| MED-01 | Replay Capture | Screenshot after each step | Yes | TBD | Keep per-step screenshots |
| MED-02 | Replay Capture | Full replay video recording | Yes, WebM recording is supported | TBD | Keep full-session video |
| MED-03 | Capture Policy | Capture only on failure | Yes | TBD | Keep failure-only capture mode |
| MED-04 | Capture Controls | Capture mode selector | Yes, supports None, Screenshots, Video, and Both | TBD | Keep explicit capture mode options |

## Environments and Settings

| ID | Minor Category | Itemized Feature | This Plugin (Autotest) | Other Plugin | Final Consolidated Feature |
|---|---|---|---|---|---|
| ENV-01 | Environments | Multiple named environment profiles | Yes, supports dev/staging/production style environments | TBD | Keep named environment profiles |
| ENV-02 | Environments | Base URL per environment | Yes | TBD | Keep base URL config |
| ENV-03 | Variables | `${VAR}` placeholder syntax | Yes | TBD | Keep `${VAR}` support |
| ENV-04 | Variables | `{{VAR}}` placeholder syntax | Yes | TBD | Keep `{{VAR}}` support |
| ENV-05 | Portability | Record once, replay anywhere | Yes | TBD | Keep portability goal |
| ENV-06 | Settings Tabs | Basic settings tab | Yes | TBD | Keep simple core settings tab |
| ENV-07 | Settings Tabs | Runner tab | Yes, runner configuration is exposed | TBD | Keep runner config |
| ENV-08 | Settings Tabs | Generator tab | Yes, generator configuration is exposed | TBD | Keep generator config |
| ENV-09 | Replay Defaults | Retry, soft assertions, viewport override | Yes | TBD | Keep replay defaults |
| ENV-10 | Recording Management | Browse recordings | Yes | TBD | Keep recording browser |
| ENV-11 | Recording Management | Search recordings | Yes | TBD | Keep recording search |
| ENV-12 | Recording Management | Filter recordings | Yes | TBD | Keep recording filters |
| ENV-13 | Recording Management | Edit recordings | Yes | TBD | Keep recording edit flow |
| ENV-14 | Recording Management | Delete recordings | Yes | TBD | Keep recording deletion |

## How To Use

1. Fill the `Other Plugin` column after reviewing the competing plugin.
2. Update `Final Consolidated Feature` with the merged end-state you want.
3. Add new rows under the correct major category when the competing plugin has extra capabilities.
4. If you want this to drive product planning, add another column such as `Priority`, `Decision`, or `Owner`.
