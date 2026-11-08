# vRO PackLens

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/imtrinity94.vro-packlens?label=VS%20Code%20Marketplace&color=0079ad)](https://marketplace.visualstudio.com/items?itemName=imtrinity94.vro-packlens)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/imtrinity94.vro-packlens?color=0079ad)](https://marketplace.visualstudio.com/items?itemName=imtrinity94.vro-packlens)

See inside any vRO `.package` file - right in VS Code.

![vRO PackLens](media/screenshot.png)

Click any `.package` file in the VS Code Explorer and it opens as a browsable tree:

- **Workflows** – in their Orchestrator folder structure, with a **schema diagram** drawn like the Orchestrator client (click a step for its bindings and script, zoom, pan, save as SVG/PNG), plus inputs, outputs, variables and every script
- **Actions** – grouped by module; inputs, return type, script
- **Configuration Elements** – folders and attributes (SecureStrings are masked)
- **Resource Elements** – metadata, text preview, *Save as…*
- **Policy Templates** and anything else in the package

Editing: click **Edit** on any script to open it in a normal editor tab; saving writes a `-modified.package` copy next to the original with the element version bumped and signatures kept. Configuration values (string/number/boolean) can be edited from the Attributes table. Scripts are colour-highlighted by language (JavaScript, PowerShell/PowerCLI, Python, Node.js).

Extras: filter by name/module/folder (optionally inside scripts), open any script or XML in a real editor tab, and **Export to folder…** to unpack the whole package as `.js` / `.xml` files you can grep or diff.

Works with packages from vRealize Orchestrator 7.x, Aria Automation Orchestrator 8.x and VCF Operations Orchestrator 9.x. The original package is never modified.

## Install
Search **vRO PackLens** in the VS Code Extensions view, or install it from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=imtrinity94.vro-packlens).

From the command line: `code --install-extension imtrinity94.vro-packlens`

Offline: Extensions view → `…` menu → **Install from VSIX…** → pick `vro-packlens-<version>.vsix`.

If another extension already claims `.package`, right-click the file → **Open with vRO PackLens** (or *Open With…* → vRO PackLens → *Configure default*).

## Build from source
```
npm install
npx @vscode/vsce package
```
A sample package for testing is in `samples/`.

## Related
[vRO Peekage](https://github.com/imtrinity94/vRO-Peekage) is the separate web app for viewing packages in a browser.

## Credits
Schema icons from [wdt4vro](https://github.com/imtrinity94/wdt4vro) (MIT); schema layout, rebuild rules and language detection ported from vRO Peekage. Syntax highlighting by [highlight.js](https://highlightjs.org) (BSD-3-Clause).
