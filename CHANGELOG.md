# Changelog

## 2026.3.1 – 2026-11-12
- Fix: configuration values of type `String` and `Text` were not editable. Orchestrator exports type names with a capital letter (`String`), and the check only matched lower-case `string`. Checked against a real package exported from Aria Automation Orchestrator 8.18.1.

## 2026.3.0 – 2026-11-08
- Edit scripts in place: **Edit** on any action or scriptable-task script opens it in a normal VS Code editor tab (.js / .ps1 / .py, so IntelliSense and your themes apply). Saving (Ctrl/Cmd+S) writes the change into `<name>-modified.package` next to the original; the original package is never changed.
- Edit configuration element values (string, number, boolean) from the Attributes table. SecureStrings stay read-only.
- Each edited element gets its version bumped once, signatures and certificates are kept, and element files are written back in their original encoding (rules from vRO Peekage's import tests on vRO 9.1).
- Edited elements are marked **M** in the tree, with an "edited" badge and a banner pointing at the modified copy (**Open copy**).
- Syntax colours by language: JavaScript (Rhino), PowerShell / PowerCLI, Python and Node.js, worked out from the action's runtime, its action environment, or the script itself. Colours follow light and dark VS Code themes.

## 2026.2.0 – 2026-11-08
- Workflow schema viewer: each workflow opens on a Schema tab drawn like the Orchestrator client (same layout, icons and arrow colours as vRO Peekage).
- Click a step to see its type, called action/workflow, next/false/error paths, bindings and script; drag to pan, Ctrl/Cmd + scroll or the toolbar to zoom, Fit / 100%.
- Save the schema as SVG or PNG.
- Workflow details split into tabs: Schema, Inputs & variables, Scripts.
- Fix: tree hierarchy was not indented inside VS Code (the webview security policy blocked inline styles).
- Fix: no longer tries to parse non-XML resource content as XML.

## 2026.1.0 – 2026-11-06
- First release of the VS Code extension (vRO PackLens).
- Custom read-only editor for `*.package` files.
- Category tree: Workflows, Actions (by module), Configuration Elements, Resource Elements, Policy Templates, Other – each in its Orchestrator folder structure.
- Detail pane for each element type; scripts open in an editor tab; copy script.
- Filter by name/module/folder, optional search inside scripts; expand/collapse all; resizable split.
- Export the whole package to a folder as `.js` / `.xml` / raw resource files.
- Handles UTF-8 / UTF-16 element data and gzip-compressed entries.
