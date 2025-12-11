chrome.commands.onCommand.addListener((command, tab) => {
    if (command === "create-sticky-note" && tab && tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: "CREATE_NOTE" });
    }
});