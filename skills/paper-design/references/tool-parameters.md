# Paper MCP Tool Parameters

Detailed parameter reference for Paper MCP tools. Tool schemas are self-describing via the MCP protocol — this documents key parameters, defaults, and return values.

---

## Reading tools

### `get_basic_info`
No parameters. Returns file name, page names, node count, artboard list with dimensions, and loaded font families.

### `get_selection`
No parameters. Returns details about currently selected nodes: IDs, names, types, size, parent artboard.

### `get_node_info`
| Param | Type | Notes |
|-------|------|-------|
| `nodeId` | string | Required. Returns size, visibility, lock state, parent, children, text content. |

### `get_children`
| Param | Type | Notes |
|-------|------|-------|
| `nodeId` | string | Required. Returns direct children: IDs, names, types, child counts. |

### `get_tree_summary`
| Param | Type | Notes |
|-------|------|-------|
| `nodeId` | string | Required. Root of the subtree to summarize. |
| `depth` | number | Optional. Default 3, max 10. Controls how deep the hierarchy is printed. |

### `get_screenshot`
| Param | Type | Notes |
|-------|------|-------|
| `nodeId` | string | Required. |
| `scale` | number | Optional. `1` (default, good for layout) or `2` (for reading small text / fine details). |
| `transparent` | boolean | Optional. Transparent background. |

Returns base64 image. Auto-capped to fit API size limits.

### `get_jsx`
| Param | Type | Notes |
|-------|------|-------|
| `nodeId` | string | Required. |
| `format` | string | `"tailwind"` (default) or `"inline-styles"`. |

### `get_computed_styles`
| Param | Type | Notes |
|-------|------|-------|
| `nodeIds` | string[] | Required. Batch — pass multiple node IDs to get styles in one call. |

### `get_fill_image`
| Param | Type | Notes |
|-------|------|-------|
| `nodeId` | string | Required. Returns base64 JPEG. Image auto-resized for AI consumption. Metadata may include original URL. |

### `get_font_family_info`
| Param | Type | Notes |
|-------|------|-------|
| `family` | string | Required. Looks up on user's machine and Google Fonts. Returns available weights and styles. Also works for web-safe fonts (Arial, Times New Roman) and CSS system fonts (system-ui, sans-serif). |

### `get_guide`
| Param | Type | Notes |
|-------|------|-------|
| `topic` | string | Required. Known topics: `"figma-import"`. Returns step-by-step guided workflow. |

### `find_placement`
No required parameters. Returns suggested x/y coordinates for placing a new artboard without overlapping existing ones.

---

## Writing tools

### `create_artboard`
| Param | Type | Notes |
|-------|------|-------|
| `name` | string | Optional. Descriptive name for the artboard. |
| `styles` | object | Optional. camelCase CSS properties as JSON: `{ width: "1440px", height: "900px" }`. |
| `relatedNodeId` | string | Optional. Place the new artboard adjacent to this node — useful for breakpoint variants. |

**Default sizes by device:**
- Desktop: 1440×900
- Tablet: 768×1024
- Mobile: 390×844

### `write_html`
| Param | Type | Notes |
|-------|------|-------|
| `html` | string | Required. Inline-styled HTML. One visual group per call. |
| `parentId` | string | Required. Target node to write into (or replace). |
| `mode` | string | `"insert-children"` (add into parent) or `"replace"` (replace parent's content). |

**Critical:** Keep payloads small (~one visual group, <15 lines). Large payloads are fragile and may fail silently.

### `set_text_content`
| Param | Type | Notes |
|-------|------|-------|
| `updates` | array | Required. Batch: `[{ nodeId: "...", text: "..." }, ...]`. |

### `update_styles`
| Param | Type | Notes |
|-------|------|-------|
| `updates` | array | Required. Batch: `[{ nodeId: "...", styles: { fontSize: "18px" } }, ...]`. Styles in camelCase. |

### `duplicate_nodes`
| Param | Type | Notes |
|-------|------|-------|
| `nodeIds` | string[] | Required. Nodes to deep-clone. |
| `parentId` | string | Optional. Reparent clones under this node. |

**Returns:** New node IDs and a `descendantIdMap` — a mapping from original descendant IDs to their cloned counterparts. Use this to modify specific parts of the clone without re-querying the tree.

### `rename_nodes`
| Param | Type | Notes |
|-------|------|-------|
| `updates` | array | Required. Batch: `[{ nodeId: "...", name: "..." }, ...]`. Names truncated at 50 characters. |

### `delete_nodes`
| Param | Type | Notes |
|-------|------|-------|
| `nodeIds` | string[] | Required. Deletes nodes and all descendants. |

**Caution:** Verify the parent/context with `get_node_info` before deleting to avoid removing the wrong subtree.

### `start_working_on_nodes`
| Param | Type | Notes |
|-------|------|-------|
| `nodeIds` | string[] | Required. Shows a working indicator on these artboards. |

### `finish_working_on_nodes`
No required parameters. Clears the working indicator from all artboards.
