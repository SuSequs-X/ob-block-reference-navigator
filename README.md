# Block Reference Navigator

A minimal, high-density sidebar panel for navigating, previewing, and exporting block-level references in Obsidian.

---

## ✨ Features

### 🔍 Block Reference Indexing

* Supports:

  * `![[file#^block]]`
  * `[[file#^block]]`
  * `![[file#heading]]`
  * `[[file#heading]]`
* Automatically scans and indexes all block-level references in the current note

---

### 📑 Minimal Sidebar Panel

* Clean, compact list-style UI
* Sequential numbering (1, 2, 3...)
* High information density
* Designed for long-term side panel usage

---

### 🧠 Structured Preview

* Markdown-aware preview (not plain text)
* Preserves:

  * Lists
  * Blockquotes
  * Headings
  * Basic formatting

---

### ✂️ Smart Summary Mode

* Block-structured summarization (not naive truncation)
* Keeps full Markdown blocks whenever possible
* Expand / collapse support

---

### 🎯 Robust Navigation

* Multi-strategy fallback:

  * Block ID
  * Heading match
  * Text snapshot
  * Line fallback
* More stable than single-anchor navigation

---

### 🧹 Smart Filtering

* Optional filtering for:

  * Low-information blocks
  * Duplicate references
* Toggle between:

  * Smart view
  * Full view

---

### 📤 Export Block References

* Export all references into a Markdown file
* Includes:

  * Source note
  * Target path
  * Block content
  * Metadata
* Configurable export options

---

## ⚙️ Settings

Minimal, native Obsidian-style settings:

* Summary mode (structured)
* Summary length
* Smart filtering
* Export behavior

---

## 🧩 Design Philosophy

> Minimal UI. Maximum signal.

* No visual noise
* No heavy cards
* No redundant explanations
* Just a fast, structured index of your block references

---

## 🚀 Use Cases

* Literature review navigation
* Knowledge graph anchoring
* Block-level linking workflows
* High-density reading and annotation

---

## 📌 Notes

* Heading references (`#heading`) may not be unique
* Block IDs (`^block`) are more stable for precise navigation
* Summary mode prioritizes structure over exact character count

---

## 📄 License

MIT
