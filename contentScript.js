// Key for storing notes for this page
function getPageKey() {
    return location.href; // per exact URL
}

const STORAGE_PREFIX = "stickyNotes:";

let notesState = []; // {id, x, y, text}

// --- Load existing notes on page load ---
loadNotesForPage().then(existingNotes => {
    notesState = existingNotes || [];
    notesState.forEach(renderNote);
});

// --- Listen for messages from background (keyboard command) ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "CREATE_NOTE") {
        const note = createNewNoteObject();
        notesState.push(note);
        renderNote(note);
        saveNotesForPage();
    }
});

// Create a new note object with default position
function createNewNoteObject() {
    return {
        id: Date.now().toString() + Math.random().toString(16).slice(2),
        x: 50,
        y: 50,
        text: ""
    };
}

// --- Storage helpers ---
function loadNotesForPage() {
    return new Promise(resolve => {
        const key = STORAGE_PREFIX + getPageKey();
        chrome.storage.local.get([key], result => {
            resolve(result[key] || []);
        });
    });
}

function saveNotesForPage() {
    const key = STORAGE_PREFIX + getPageKey();
    chrome.storage.local.set({ [key]: notesState });
}

// --- DOM creation ---
function renderNote(note) {
    const existing = document.querySelector(`[data-sticky-note-id="${note.id}"]`);
    if (existing) existing.remove();

    const noteEl = document.createElement("div");
    noteEl.className = "sticky-note";
    noteEl.dataset.stickyNoteId = note.id;
    noteEl.style.left = note.x + "px";
    noteEl.style.top = note.y + "px";

    const headerEl = document.createElement("div");
    headerEl.className = "sticky-note-header";
    headerEl.textContent = "Note";
    noteEl.appendChild(headerEl);

    const closeBtn = document.createElement("button");
    closeBtn.className = "sticky-note-close";
    closeBtn.textContent = "×";
    headerEl.appendChild(closeBtn);

    const bodyEl = document.createElement("div");
    bodyEl.className = "sticky-note-body";
    bodyEl.contentEditable = "true";
    bodyEl.innerText = note.text || "";
    noteEl.appendChild(bodyEl);

    document.body.appendChild(noteEl);

    // Drag behavior on header
    makeDraggable(noteEl, headerEl, note.id);

    // Close behavior
    closeBtn.addEventListener("click", () => {
        notesState = notesState.filter(n => n.id !== note.id);
        noteEl.remove();
        saveNotesForPage();
    });

    // Edit behavior
    bodyEl.addEventListener("input", () => {
        const n = notesState.find(n => n.id === note.id);
        if (n) {
            n.text = bodyEl.innerText;
            saveNotesForPage();
        }
    });
}

function makeDraggable(noteEl, dragHandleEl, noteId) {
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    dragHandleEl.style.cursor = "move";

    dragHandleEl.addEventListener("mousedown", (e) => {
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
        const newLeft = initialLeft + dx;
        const newTop = initialTop + dy;

        noteEl.style.left = newLeft + "px";
        noteEl.style.top = newTop + "px";
    }

    function onMouseUp() {
        if (!isDragging) return;
        isDragging = false;

        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);

        // Update and save final position
        const rect = noteEl.getBoundingClientRect();
        const n = notesState.find(n => n.id === noteId);
        if (n) {
            n.x = rect.left;
            n.y = rect.top;
            saveNotesForPage();
        }
    }
}