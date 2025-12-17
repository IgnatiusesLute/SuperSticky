// contentScript.js


function getPageKey() {
    return location.href;
}

const STORAGE_PREFIX = "stickyNotes:";
let notesState = [];

const SAVE_DEBOUNCE_MS = 300;
let saveTimer = null;

function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNotesForPage, SAVE_DEBOUNCE_MS);
}

function loadNotesForPage() {
    return new Promise((resolve) => {
        const key = STORAGE_PREFIX + getPageKey();
        chrome.storage.local.get([key], (result) => resolve(result[key] || []));
    });
}

function saveNotesForPage() {
    const key = STORAGE_PREFIX + getPageKey();
    chrome.storage.local.set({ [key]: notesState });
}

// ---------- Boot ----------
loadNotesForPage().then((existingNotes) => {
    notesState = existingNotes || [];
    notesState.forEach(renderNote);

    // Recreate anchors for notes that have them
    attemptReanchors("initial");

    // Retry once for late-rendering content
    setTimeout(() => attemptReanchors("delayed-1s"), 1000);

    // Light MutationObserver to catch SPA/dom re-renders (short-lived)
    startShortReanchorObserver();
});

chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "CREATE_NOTE") {
        const note = createNewNoteObject();
        notesState.push(note);
        renderNote(note);
        saveNotesForPage();
    }
});

// ---------- Note model ----------
function createNewNoteObject() {
    return {
        id: Date.now().toString() + Math.random().toString(16).slice(2),
        x: 50,
        y: 50,
        width: 200,
        height: 140,
        text: "",
        minimized: false,
        anchor: null // { quote, prefix, suffix }
    };
}

// ---------- Rendering ----------
function renderNote(note) {
    const existing = document.querySelector(`[data-sticky-note-id="${note.id}"]`);
    if (existing) existing.remove();

    const noteEl = document.createElement("div");
    noteEl.className = "sticky-note";
    noteEl.dataset.stickyNoteId = note.id;
    noteEl.style.left = note.x + "px";
    noteEl.style.top = note.y + "px";
    noteEl.style.width = (note.width || 200) + "px";
    noteEl.style.height = (note.height || 140) + "px";

    if (note.minimized) noteEl.classList.add("minimized");

    const headerEl = document.createElement("div");
    headerEl.className = "sticky-note-header";
    headerEl.textContent = "Note";
    noteEl.appendChild(headerEl);

    const closeBtn = document.createElement("button");
    closeBtn.className = "sticky-note-close";
    closeBtn.textContent = "×";
    headerEl.appendChild(closeBtn);

    const attachBtn = document.createElement("button");
    attachBtn.className = "sticky-note-attach";
    attachBtn.textContent = "Attach";
    headerEl.appendChild(attachBtn);

    const bodyEl = document.createElement("div");
    bodyEl.className = "sticky-note-body";
    bodyEl.contentEditable = "true";
    bodyEl.innerText = note.text || "";
    noteEl.appendChild(bodyEl);

    document.body.appendChild(noteEl);

    const ro = new ResizeObserver(() => {
        // Ignore when minimized (display:none can cause weird sizes)
        if (noteEl.classList.contains("minimized")) return;

        const rect = noteEl.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;

        const n = notesState.find(n2 => n2.id === note.id);
        if (!n) return;

        n.width = Math.round(rect.width);
        n.height = Math.round(rect.height);
        scheduleSave(); // debounced save
    });
    ro.observe(noteEl);

    // Drag behavior on header
    makeDraggable(noteEl, headerEl, note.id);

    // Close behavior
    closeBtn.addEventListener("click", () => {
        // Remove any existing anchor span for this note
        const anchorEl = document.querySelector(`.sticky-note-anchor[data-note-id="${note.id}"]`);
        if (anchorEl) unwrapAnchorSpan(anchorEl);

        notesState = notesState.filter((n) => n.id !== note.id);
        noteEl.remove();
        saveNotesForPage();
    });

    // Edit behavior (debounced)
    bodyEl.addEventListener("input", () => {
        const n = notesState.find((n2) => n2.id === note.id);
        if (!n) return;
        n.text = bodyEl.innerText;
        scheduleSave();
    });

    // Attach behavior
    attachBtn.addEventListener("click", () => {
        const anchor = captureSelectionAnchor();
        if (!anchor) return;

        const n = notesState.find((n2) => n2.id === note.id);
        if (!n) return;

        // Save anchor data for persistence
        n.anchor = anchor;
        n.minimized = true;

        // Wrap selection now (visual highlight). If it fails,  still saved anchor;
        // on reload will attempt re-anchoring again.
        const wrapped = wrapCurrentSelectionWithAnchor(note.id);

        noteEl.classList.add("minimized");
        saveNotesForPage();

        // If wrap succeeded, ensure click opens note
        if (wrapped) {
            // nothing else
        }
    });
}

// ---------- Open/minimize ----------
function openNote(noteId) {
    const noteEl = document.querySelector(`[data-sticky-note-id="${noteId}"]`);
    if (!noteEl) return;

    noteEl.classList.remove("minimized");

    const n = notesState.find((n2) => n2.id === noteId);
    if (n) {
        n.minimized = false;
        saveNotesForPage();
    }
}
function minimizeNote(noteId) {
    const noteEl = document.querySelector(`[data-sticky-note-id="${noteId}"]`);
    if (!noteEl) return;

    noteEl.classList.add("minimized");

    const n = notesState.find(n2 => n2.id === noteId);
    if (n) {
        n.minimized = true;
        saveNotesForPage();
    }
}

function toggleNote(noteId) {
    const noteEl = document.querySelector(`[data-sticky-note-id="${noteId}"]`);
    if (!noteEl) return;

    if (noteEl.classList.contains("minimized")) openNote(noteId);
    else minimizeNote(noteId);
}

// ---------- Drag ----------
function makeDraggable(noteEl, dragHandleEl, noteId) {
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    dragHandleEl.style.cursor = "move";

    dragHandleEl.addEventListener("mousedown", (e) => {
        // Don't start drag if clicking buttons in the header
        if (e.target && (e.target.classList.contains("sticky-note-close") || e.target.classList.contains("sticky-note-attach"))) {
            return;
        }

        e.preventDefault();
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = noteEl.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
    });

    function onMouseMove(e) {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        noteEl.style.left = initialLeft + dx + "px";
        noteEl.style.top = initialTop + dy + "px";
    }

    function onMouseUp() {
        if (!isDragging) return;
        isDragging = false;

        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);

        const rect = noteEl.getBoundingClientRect();
        const n = notesState.find((n2) => n2.id === noteId);
        if (n) {
            n.x = rect.left;
            n.y = rect.top;
            saveNotesForPage();
        }
    }
}

// ---------- Anchoring: capture selection ----------
function captureSelectionAnchor() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0);
    if (range.collapsed) return null;

    // Ignore selections inside our own notes UI
    const common = range.commonAncestorContainer;
    const commonEl = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement;
    if (commonEl && commonEl.closest && commonEl.closest(".sticky-note")) return null;

    const quote = sel.toString();
    if (!quote || !quote.trim()) return null;

    // Use a window of surrounding text from a reasonable container
    const container =
        range.commonAncestorContainer.nodeType === Node.TEXT_NODE
            ? range.commonAncestorContainer.parentElement
            : range.commonAncestorContainer;

    const containerText = (container && (container.innerText || container.textContent)) || "";
    if (!containerText) return { quote, prefix: "", suffix: "" };

    // Best-effort: find the first occurrence of quote in container text for prefix/suffix
    const idx = containerText.indexOf(quote);
    if (idx === -1) return { quote, prefix: "", suffix: "" };

    const prefix = containerText.slice(Math.max(0, idx - 30), idx);
    const suffix = containerText.slice(idx + quote.length, idx + quote.length + 30);

    return { quote, prefix, suffix };
}

// ---------- Anchoring: wrap selection now ----------
function wrapCurrentSelectionWithAnchor(noteId) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;

    const range = sel.getRangeAt(0);
    if (range.collapsed) return false;

    // Prevent nesting: if selection already inside an anchor, reuse it
    const startEl =
        range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range.startContainer.parentElement;
    if (startEl && startEl.closest) {
        const existingAnchor = startEl.closest(".sticky-note-anchor");
        if (existingAnchor) {
            existingAnchor.dataset.noteId = noteId;
            existingAnchor.addEventListener("click", (e) => {
                e.stopPropagation();
                toggleNote(noteId);
            });
            sel.removeAllRanges();
            return true;
        }
    }

    const span = document.createElement("span");
    span.className = "sticky-note-anchor";
    span.dataset.noteId = noteId;

    try {
        // Robust across multiple nodes:
        const frag = range.extractContents();
        span.appendChild(frag);
        range.insertNode(span);
    } catch {
        return false;
    }

    sel.removeAllRanges();

    span.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleNote(noteId);
    });

    return true;
}

function unwrapAnchorSpan(anchorEl) {
    // Replace the span with its children
    const parent = anchorEl.parentNode;
    if (!parent) return;

    while (anchorEl.firstChild) {
        parent.insertBefore(anchorEl.firstChild, anchorEl);
    }
    parent.removeChild(anchorEl);
}

// ---------- Anchoring: persistence (Option B improved) ----------
// Build a normalized flattened string of all text nodes, plus a map from each char to node+offset.
// Normalization: collapse whitespace to single spaces (keeps indices consistent with map).
function buildNormalizedDocumentIndex() {
    const nodes = getSearchableTextNodes();

    let flat = "";
    const map = []; // map[i] = { node, offset }

    let lastWasSpace = true;

    for (const node of nodes) {
        const raw = node.nodeValue || "";
        for (let i = 0; i < raw.length; i++) {
            const ch = raw[i];

            // Normalize NBSP and whitespace
            const isSpace = /\s/.test(ch) || ch === "\u00A0";
            if (isSpace) {
                if (!lastWasSpace) {
                    flat += " ";
                    map.push({ node, offset: i });
                    lastWasSpace = true;
                }
            } else {
                flat += ch;
                map.push({ node, offset: i });
                lastWasSpace = false;
            }
        }

        // Separator between nodes
        if (!lastWasSpace) {
            flat += " ";
            map.push({ node, offset: raw.length - 1 });
            lastWasSpace = true;
        }
    }

    return { flat, map };
}

function getSearchableTextNodes() {
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode(node) {
                if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;

                const p = node.parentElement;
                if (!p) return NodeFilter.FILTER_REJECT;

                const tag = p.tagName;
                if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
                if (p.closest(".sticky-note")) return NodeFilter.FILTER_REJECT;

                // Avoid anchoring inside contenteditable regions (often dynamic editors)
                if (p.closest('[contenteditable="true"]')) return NodeFilter.FILTER_REJECT;

                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
}

function normalizeForMatch(s) {
    return (s || "")
        .replace(/\u00A0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function findAllOccurrences(haystack, needle) {
    const results = [];
    if (!needle) return results;
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
        results.push(idx);
        idx = haystack.indexOf(needle, idx + 1);
    }
    return results;
}

function findAnchorMatchInDocument(anchor) {
    const quote = normalizeForMatch(anchor.quote);
    if (!quote) return null;

    const prefix = normalizeForMatch(anchor.prefix);
    const suffix = normalizeForMatch(anchor.suffix);

    const { flat, map } = buildNormalizedDocumentIndex();
    const candidates = findAllOccurrences(flat, quote);
    if (!candidates.length) return null;

    // Score candidates with prefix/suffix
    let bestStart = candidates[0];
    let bestScore = -1;

    for (const startIdx of candidates) {
        const endIdx = startIdx + quote.length;

        const before = normalizeForMatch(flat.slice(Math.max(0, startIdx - 80), startIdx));
        const after = normalizeForMatch(flat.slice(endIdx, Math.min(flat.length, endIdx + 80)));

        let score = 0;

        if (prefix) {
            if (before.endsWith(prefix)) score += 3;
            else if (before.includes(prefix.slice(-10))) score += 1;
        }
        if (suffix) {
            if (after.startsWith(suffix)) score += 3;
            else if (after.includes(suffix.slice(0, 10))) score += 1;
        }

        if (score > bestScore) {
            bestScore = score;
            bestStart = startIdx;
        }
    }

    const startRef = map[bestStart];
    const endRef = map[bestStart + quote.length - 1];

    if (!startRef || !endRef || !startRef.node || !endRef.node) return null;

    return {
        startNode: startRef.node,
        startOffset: startRef.offset,
        endNode: endRef.node,
        endOffset: endRef.offset + 1 // end is exclusive
    };
}

function wrapRangeWithAnchorSpan(range, noteId) {
    if (!range || range.collapsed) return false;

    // If an anchor already exists for this note, don't create another
    if (document.querySelector(`.sticky-note-anchor[data-note-id="${noteId}"]`)) return true;

    const span = document.createElement("span");
    span.className = "sticky-note-anchor";
    span.dataset.noteId = noteId;

    try {
        const frag = range.extractContents();
        span.appendChild(frag);
        range.insertNode(span);
    } catch {
        return false;
    }

    span.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleNote(noteId);
    });

    return true;
}

function reanchorNote(noteId, anchor) {
    // Don't duplicate
    if (document.querySelector(`.sticky-note-anchor[data-note-id="${noteId}"]`)) return;

    const match = findAnchorMatchInDocument(anchor);
    if (!match) return;

    const range = document.createRange();
    range.setStart(match.startNode, match.startOffset);
    range.setEnd(match.endNode, match.endOffset);

    wrapRangeWithAnchorSpan(range, noteId);
}

function attemptReanchors(reason) {
    // Try to (re)create anchors for notes that have them
    for (const note of notesState) {
        if (note.anchor && note.anchor.quote) {
            reanchorNote(note.id, note.anchor);
        }
    }
}

// Observe DOM changes briefly to re-anchor notes on SPAs / late renders
function startShortReanchorObserver() {
    let attempts = 0;
    const maxAttempts = 6;

    const observer = new MutationObserver(() => {
        attempts++;
        attemptReanchors("mutation-" + attempts);
        if (attempts >= maxAttempts) observer.disconnect();
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Hard stop after ~6 seconds
    setTimeout(() => observer.disconnect(), 6000);
}
