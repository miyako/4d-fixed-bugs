# Phase 2 Pilot — 40 Bug Summaries

## ACI0100292

**Versions:** 18

**Original:** Properties names not shown in form property list for SPANISH and PORTUGUESE localization.

**Summary:** In the Form Editor's property list, property names failed to display at all when the interface localization was set to Spanish or Portuguese, leaving the property panel effectively blank for those languages.

## ACI0100846

**Versions:** 17.4_hf2, 18.2_hf1, 18.3, 18_r4

**Original:** Wrong date format for localisation "English (Singapore)".

**Summary:** On Windows, with the region/language set to English (Singapore), the system date abbreviated format was rendered incorrectly: dates displayed as `MM/DD/YY` instead of the locale-correct `DD/MM/YY`.

## ACI0100946

**Versions:** 18_r5

**Original:** In project mode only, group visual boundaries not redrawn in the form editor after resizing or moving an object that belongs to the group

**Summary:** In Project mode only, moving or resizing an object that belongs to a Form Editor group did not refresh the group's overall bounding box — the group's visual outline stayed at its old position/size instead of updating to enclose its members.

## ACI0101273

**Versions:** 18.3_hf3, 18.4, 18_r5

**Original:** The French version of 4D does not recognize the constant "mail disposition en pièce-jointe" of the 4D French command "MAIL Créer pièce jointe".

**Summary:** In the French edition of 4D, the constant `mail disposition en pièce-jointe` (used with the French-localized mail-attachment command) was not recognized by the compiler/interpreter, causing the constant to be rejected where it should have been valid.

## ACI0101296

**Versions:** 18_r5

**Original:** Attempting to connect to a remote DS where an exposed table has a relation to a non-exposed table causes error

**Summary:** Connecting to a remote datastore failed with a "relation cannot be resolved" error whenever a REST-exposed table had a relation pointing to a table that was not itself REST-exposed. The relation resolver did not tolerate a mix of exposed/non-exposed related tables.

## ACI0101339

**Versions:** 18.4, 18_r6

**Original:** On Windows, cursor moves to start of block during Japanese conversion; the cursor should stay where it was, usually at the end of the block.

**Summary:** On Windows, during Japanese (IME) text conversion, the text cursor incorrectly jumped to the start of the conversion block instead of remaining at its expected position (typically the end of the block). This affected any text-entry context handling IME composition.

## ACI0101581

**Versions:** 18_r6

**Original:** The command 'WA OPEN WEB INSPECTOR' makes 4D to crash (embeddedEngineActivated) when uploading blank page or just a web area.

**Summary:** With a CEF-based web area displaying a blank page, calling [`WA OPEN WEB INSPECTOR`](https://developer.4d.com/docs/commands/wa-open-web-inspector) crashed the application instead of opening the inspector, whether the web area itself was empty or no web area was present at all.

## ACI0101812

**Versions:** 18.4_hf3, 18.5, 19

**Original:** Crash upon inserting a method containing "WP INSERT TABLE"

**Summary:** Inserting a method whose code referenced [`WP Insert table`](https://developer.4d.com/docs/commands/wp-insert-table) (4D Write Pro) into another method via the code editor caused a crash.

## ACI0101848

**Versions:** 19

**Original:** TypeAhead in method editor does not work with all methods when a Compiler_xxx' method exist

**Summary:** Type-ahead (auto-complete) suggestions in the method editor stopped working for some methods whenever a method named with a `Compiler_xxx` prefix existed in the project, indicating the type-ahead indexer mishandled that naming pattern.

## ACI0101893

**Versions:** 18.4_hf3, 18.5

**Original:** 4D View Pro: Prniting a document with picture returned by 4D functions does not work properly: the picture is replaced by "_Pict_".

**Summary:** In 4D View Pro, printing a spreadsheet to PDF via [`VP PRINT`](https://developer.4d.com/docs/commands/vp-print) mis-rendered any cell populated by a 4D formula that returns a picture: the picture was replaced by the placeholder text `_Pict_` instead of the actual image. Exporting the same document to PDF (rather than printing) was unaffected, isolating the bug to the print pipeline's picture-formula handling.

## ACI0101978

**Versions:** 18.5_hf3, 18.6, 19.1, 19_r3

**Original:** LDAP Object GUID returned from 'LDAP Search' is a wrong text.

**Summary:** In LDAP directories that expose a binary `objectGUID` attribute (such as Microsoft Active Directory), [`LDAP Search`](https://developer.4d.com/docs/commands/ldap-search) converted the binary GUID to a string incorrectly, producing garbled/mojibake text instead of a readable value. The command previously assumed all attribute values were plain numeric-to-string conversions, which does not apply to binary GUID data. The fix returns the GUID as a proper hexadecimal string. Platforms without this Active-Directory-specific binary property (e.g. Ubuntu-based LDAP servers) were unaffected.

## ACI0102606

**Versions:** 19.2, 19_r5

**Original:** '#DECLARE' parameter names are case sensitive in compiled mode: It distinguishes a lettre in capital letter and lowercase.

**Summary:** In compiled mode, parameter names declared with the `#DECLARE` directive were treated as case-sensitive, distinguishing uppercase from lowercase letters in a name — inconsistent with interpreted-mode behavior, where parameter names are not case-sensitive.

## ACI0102783

**Versions:** 19.2_hf2, 19.3, 19_r5

**Original:** Keyboard shortcuts defined in the structure are not retrieved in the user properties.

**Summary:** Custom keyboard shortcuts defined at the structure/project level were not carried over into (inherited by) per-user settings, so users lost their structure-defined shortcuts in their personal configuration.

## ACI0102950

**Versions:** 19_r8

**Original:** Multi ViewPro "On VP Ready" does not run on Mac

**Summary:** On macOS, the `On VP Ready` View Pro form event did not fire for spreadsheets inside a Multi View Pro area, so initialization code relying on that event never ran.

## ACI0103039

**Versions:** 19.4, 19_r6

**Original:** In macOS QR use between 80% and 100% of CPU when the quick report is opened

**Summary:** On macOS, opening the Quick Report editor caused CPU usage to spike to 80–100%. The excessive load traced to an internal infinite loop between [`SET TIMER`](https://developer.4d.com/docs/commands/set-timer) and the *On Bound Variable Change* form event.

## ACI0103071

**Versions:** 19.3_hf2, 19.4, 19_r6

**Original:** The extended character entry on Mac after a long press, does not work correctly anymore.

**Summary:** On macOS, long-pressing a key to enter an extended/accented character no longer worked. The fix restores the accent-picker popover for long presses across combo boxes, the Structure editor, Write Pro, View Pro, list boxes, text-entry areas, and the property list, giving the macOS accent picker priority over continuous key repeat (`ApplePressAndHoldEnabled`) when the system preference for it is enabled. When an IME (e.g. Japanese input) is active, continuous repeat still takes priority over the accent picker; when the system's press-and-hold accent picker is disabled entirely, long presses are always treated as key repeat.

## ACI0103405

**Versions:** 19.5, 19_r8

**Original:** Blank pdf files gets created when opening and closing print job

**Summary:** Starting and then immediately ending a print job with the output destination set to PDF (without printing any content) still created an empty PDF file on disk.

## ACI0103460

**Versions:** 19_r7

**Original:** 'GRAPH' 4D command without legends may throw an unexpected execution error

**Summary:** Calling [`GRAPH`](https://developer.4d.com/docs/commands/graph) to build a chart with no legend threw an unexpected runtime error. This was a side effect of the fix for ACI0103151.

## ACI0104078

**Versions:** 20.1, 20_r2

**Original:** Tip for commands like 'SVG_Export_to_picture' is badly rendered (HTML <span> tag visible)

**Summary:** The help tooltip shown when hovering over component methods (e.g. `SVG_Export_to_picture`-style names) rendered raw styled-text markup instead of formatted text — HTML-like `<span>` tags appeared literally in the tooltip rather than being interpreted.

## ACI0104111

**Versions:** 20.2, 20_r2_hf1, 20_r3

**Original:** Operators "+" and "-" and anything following them are unexpectedly being concatened to the first process variable (operand) when the name starts with a digit. And so, the operation is not executed ; the variable is undefined.

**Summary:** In the compiler/interpreter, declaring a variable name that starts with a digit followed by the letter `e` (e.g. `1ECostBasis`) and then using it with a `+` or `-` operator caused the operator (and everything after it) to be tokenized as part of that variable name, since `1e` is also a valid exponent-notation prefix for numeric literals. As a result the intended arithmetic operation silently failed to execute and the variable was left undefined. Older 4D versions had permitted such digit-leading names; the parser's tokenizer now handles the ambiguity between exponent notation and variable names correctly.

## ACI0104152

**Versions:** 20.1_hf1, 20.2, 20_r2

**Original:** xliff references on 3D buttons are not resolved correctly after the cmd object set format

**Summary:** On 3D buttons whose titles were set via XLIFF localization resources, updating the title afterward with [`OBJECT SET FORMAT`](https://developer.4d.com/docs/commands/object-set-format) caused the XLIFF resource *name* (key) to be displayed literally as the button's title, instead of the resolved localized string.

## ACI0104187

**Versions:** 20.1_hf1, 20.2, 20_r3

**Original:** A crash may happen on calling the 4D command 'Get process activity'.

**Summary:** Calling [`Get process activity`](https://developer.4d.com/docs/commands/process-activity) while a new process was being started to perform an HTTP request could crash the application, due to a race between process-activity introspection and process/network initialization.

## ACI0104191

**Versions:** 19.7, 20.1_hf1, 20.2, 20_r2

**Original:** When the 'Encrypt Client-Server Communications' option is ON, disconnection errors could occur on the '4D Remote' side after a postponed state of a process; potentially, it leads to memory corruption.

**Summary:** With "Encrypt Client-Server Communications" enabled, if a TLS connection was closed while in a postponed/deferred state, 4D attempted to close the underlying socket a second time, causing memory corruption on the 4D Remote side. This was a regression introduced by the fix for ACI0103972 (client disconnection errors).

## ACI0104387

**Versions:** 20.2_hf1, 20.3, 20_r3

**Original:** 4D Write Pro: Depending of HTML text, it may crash 4D Write Pro when opening it.

**Summary:** On Windows, opening an HTML document in 4D Write Pro containing a very large number (1,000+) of nested `<div>` elements crashed the application. The fix caps effective nesting: since HTML with more than 100 levels of nesting is not a supported/recommended structure, 4D Write Pro no longer crashes but silently ignores nesting beyond the 100th level.

## ACI0104534

**Versions:** 20_r5

**Original:** The interface doesn't remain consistent when windows with size constraints are resized using the Maximize Window command.

**Summary:** For windows with minimum/maximum size constraints, using the "Maximize Window" toolbox command to resize the window left the interface layout in an inconsistent state (controls not properly relaid out for the new size).

## ACI0104549

**Versions:** 19.7_hf3, 19.8, 20.3, 20_r4

**Original:** A memory corruption when using SSO with ServerNet could occur and generate a freeze of 4D Remote (from client side).

**Summary:** When the new network layer's "domain server user authentication" (SSO) option was enabled, a memory leak could occur that eventually froze 4D Remote client processes. This was a regression side effect introduced by the fix for ACI0103215 (client disconnection issue).

## ACI0104686

**Versions:** 20.3_hf2, 20.4, 20_r5

**Original:** verticalAlign attribute in CSS file does not work properly in Form editor preview

**Summary:** Setting the CSS `verticalAlign` property on a list box column (to control vertical alignment of column content) had no visible effect in the Form Editor's live preview, even though the property was applied correctly at form runtime.

## ACI0104752

**Versions:** 20.3_hf2, 20.4, 20_r4_hf1, 20_r5

**Original:** 4D Write Pro: decimal tab marker can't align on trailing spaces if they are any because these are unexpectedly truncated.

**Summary:** In 4D Write Pro, a decimal tab stop failed to align correctly when trailing spaces followed the aligned text — the trailing spaces were unexpectedly truncated before alignment was computed. Microsoft Word handles this case by aligning on the decimal point while preserving trailing spaces; Write Pro's decimal-tab logic now matches that behavior.

## ACI0104951

**Versions:** 20_r7

**Original:** The scrolling is not working when "multiline" is set to "1" by command on a one line text input

**Summary:** On a single-line text input object, enabling multi-line behavior at runtime (by setting the `multiline` object property to `1` via code rather than at design time) did not enable scrolling within the field as expected.

## ACI0105178

**Versions:** 21

**Original:** Starting a /* comment in a continuation line (\) causes the editor to treat all following code as a comment, even after */ is added.

**Summary:** In the code editor, starting a `/*` block comment on a line that begins with a line-continuation backslash (`\`) caused the editor to treat everything from that point onward as commented out, even after a matching `*/` was typed — the continuation character confused the comment-block parser.

## ACI0105455

**Versions:** 20_r8

**Original:** Unexpected compiler warning may happen: "Assumes that the pointer points to an alphanumeric expression. (533.1)"

**Summary:** Using the string index operator (`[[]]`) syntax on an object property triggered a spurious compiler warning: "Assumes that the pointer points to an alphanumeric expression (533.1)". The warning message wording around "pointer target" was also reworded as part of this fix to reduce confusion.

## ACI0105764

**Versions:** 21

**Original:** Syntax checking does not detect errors when a conditional expression that should evaluate to a boolean value uses an expression containing an operator with an object notation expression.

**Summary:** The code editor's syntax checker failed to flag an error when a conditional (`If`/`Case of`, etc.) expression — which must evaluate to a boolean — instead used an operator combined with object-notation (dot) expressions in a way that does not produce a boolean result.

## ACI0105901

**Versions:** 21

**Original:** Table preview doesn't display in Explorer

**Summary:** In the Explorer, selecting a table did not immediately show its data preview; sending the Explorer window to the back and then bringing it to the front again would make the preview appear, indicating a refresh/redraw ordering issue.

## ACI0106160

**Versions:** 21.0_hf1, 21.1, 21_r3

**Original:** 4D Qodly Pro - Nested Matrices Intermittently Fail to Load Data

**Summary:** In 4D Qodly Pro, nesting Matrix components inside one another caused data to intermittently fail to load into the nested matrices.

## ACI0106206

**Versions:** 21.1, 21_r3

**Original:** With the 4D commands 'License usage', the session.UserName is empty.

**Summary:** The `session.userName` property returned by [`License usage`](https://developer.4d.com/docs/commands/license-usage) was empty instead of containing the connected user's name.

## ACI0106220

**Versions:** 21.1_hf2

**Original:** Bad display of 'user and groups' editor when not an administrator.

**Summary:** In the Toolbox, opening the "Users and Groups" editor while logged in as a non-administrator user rendered the interface incorrectly: some icon images failed to display and message/label positions were misplaced.

## ACI0106245

**Versions:** 21.1, 21_r2_hf1, 21_r3

**Original:** The behaviour of the Debugger's 'Step Over' function may not work properly when there are several methods as parameters.

**Summary:** In the debugger, "Step Over" did not behave correctly when stepping through a method call whose parameters were themselves method calls (e.g. `Method4(Method1; Method3(Method2))`). Previously, stepping followed the correct nested call/parameter evaluation order; the fix restores step-in/step-out ordering to match parameter nesting and left-to-right evaluation order.

## ACI0106267

**Versions:** 21.1, 21_r2

**Original:** 4D Remote may stop responding (freeze) after multiple processes perform database queries using the "QUIC" network layer

**Summary:** Using the QUIC network layer, 4D Remote could stop responding (freeze) after client-side code repeatedly started large numbers of processes, let them terminate, and then started large numbers of processes again — indicating a resource cleanup issue in the QUIC transport under repeated process churn.

## ACI0106305

**Versions:** 21_r2, 21_r3

**Original:** 4D may crash when a breakpoint is set on a method.

**Summary:** Setting a breakpoint on a method while the Explorer window was not visible/open could crash the application.

## ACI0106460

**Versions:** 21.1_hf2

**Original:** Toolbox Editor: the right panel of the 'List' tab may be hidden or bad displayed after switching between 4D and other applications.

**Summary:** In the Toolbox editor's "List" tab, the right-hand panel could become hidden or badly rendered after switching focus away to another application and back to 4D.
