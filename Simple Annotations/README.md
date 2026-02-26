# Simple Annotations

A Figma plugin for attaching clean, structured annotation notes directly to elements on the canvas.

---

## Features

- **Multi-note annotations** — attach multiple labelled notes (short label + description) to any canvas element
- **Color-coded labels** — choose from 7 swatch colors per note, with WCAG-accessible text contrast automatically applied
- **Connector line** — a dashed connector with a dot automatically links the annotation to the selected element and updates when you move things around
- **Light / Dark theme** — toggle between light and dark annotation card styles
- **Border toggle** — optionally match the annotation border to the connector color
- **Reusable labels** — labels you create are saved locally and suggested as you type, across sessions
- **Document labels** — labels used anywhere in the current document also appear as suggestions
- **Direct canvas editing** — edit annotation text directly on the canvas; changes sync back to the plugin
- **Smart selection** — click any child element inside an annotation to load it into edit mode; the plugin scrolls to the matching note automatically

---

## How to Use

1. **Select an element** on the canvas you want to annotate
2. **Open the plugin** — it will enter "Create" mode
3. **Fill in your notes** — add a short label and/or description for each Note
4. **Click "Create Annotation"** — the annotation card is placed to the right of your selection with a connector line drawn automatically
5. **To edit** — select the annotation frame (or any element inside it) to reload it in the plugin, make changes, then click "Done"

### Tips

- The connector line updates automatically when you move either the annotation or the target element
- You can add multiple Notes per annotation using the **+ Add Note** button
- Labels you've used before will appear in the dropdown as you type — click to apply them quickly
- Keep the plugin window open while moving annotations around the canvas for the connector to stay in sync

---

## Privacy

Simple Annotations stores label data locally on your device using Figma's `clientStorage` API. No data is collected, transmitted, or shared with any third party. See [PRIVACY_POLICY.md](./PRIVACY_POLICY.md) for full details.

---

## Support

Found a bug or have a feature request? [Open an issue on GitHub](https://github.com/mathewsamueldesign/figma-simple-annotations/issues).
